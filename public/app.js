const state = { user: null, panel: "chats", chats: [], selected: null, recording: false, mediaRecorder: null, audioChunks: [], poller: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
const avatarClass = (color = "") => color.includes("ff8d") ? "avatar-peach" : color.includes("63c8") ? "avatar-mint" : color.includes("6eaf") ? "avatar-blue" : "avatar-lilac";
const avatar = (person, extra = "") => `<span class="avatar ${avatarClass(person.avatarColor)} ${extra}">${esc((person.displayName || person.username || "?").charAt(0).toUpperCase())}</span>`;
const timeAgo = (date) => {
  if (!date) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < 45) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return new Date(date).toLocaleDateString([], { month: "short", day: "numeric" });
};
const clock = (date) => date ? new Date(date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
const lastSeen = (date) => {
  if (!date) return "offline";
  const day = new Date(date).toLocaleDateString() === new Date().toLocaleDateString();
  return day ? `last seen ${clock(date)}` : `last seen ${new Date(date).toLocaleDateString([], { month: "short", day: "numeric" })}`;
};
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}
function toast(message, error = false) {
  const node = document.createElement("div");
  node.className = `toast${error ? " error" : ""}`;
  node.textContent = message;
  $("#toastStack").appendChild(node);
  setTimeout(() => node.remove(), 3500);
}
function switchAuth(mode) {
  const signup = mode === "signup";
  $$(".auth-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.auth === mode));
  $("#displayNameField").classList.toggle("hidden", !signup);
  $("#displayNameField input").required = signup;
  $("#authEyebrow").textContent = signup ? "MAKE YOUR SPACE" : "WELCOME BACK";
  $("#authTitle").textContent = signup ? "A place to be you." : "Come on in.";
  $("#authSubtitle").textContent = signup ? "Create your account and find your people." : "Your people are only a message away.";
  $("#authButtonText").textContent = signup ? "Create my Harkly" : "Sign in to Harkly";
  $("#authFootnote").innerHTML = signup ? 'Already have an account? <button type="button" data-switch-auth="signin">Sign in instead</button>' : 'New here? <button type="button" data-switch-auth="signup">Create a free account</button>';
  $("#authForm").dataset.mode = mode;
  $("#authForm").reset();
  $("#authError").textContent = "";
}
async function submitAuth(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const mode = event.currentTarget.dataset.mode || "signin";
  const body = mode === "signup" ? { displayName: form.get("displayName"), username: form.get("identifier"), password: form.get("password") } : { identifier: form.get("identifier"), password: form.get("password") };
  $("#authError").textContent = "";
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const data = await api(`/api/auth/${mode}`, { method: "POST", body: JSON.stringify(body) });
    state.user = data.user;
    showApp();
  } catch (error) {
    $("#authError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}
function showApp() {
  $("#authView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  $("#profileAvatar").className = `avatar ${avatarClass(state.user.avatarColor)}`;
  $("#profileAvatar").textContent = state.user.displayName.charAt(0).toUpperCase();
  $("#profileName").textContent = state.user.displayName;
  $("#profileUsername").textContent = `@${state.user.username}`;
  loadChats();
  loadRequests();
  loadNotifications();
  clearInterval(state.poller);
  state.poller = setInterval(() => { loadChats(true); loadNotifications(true); if (state.selected) loadConversation(state.selected.id, true); }, 4500);
}
function showAuth() {
  $("#appView").classList.add("hidden");
  $("#authView").classList.remove("hidden");
  clearInterval(state.poller);
}
async function loadChats(silent = false) {
  try {
    const data = await api("/api/chats");
    state.chats = data.chats;
    renderChats();
    updateCounts();
  } catch (error) { if (!silent) toast(error.message, true); }
}
function renderChats() {
  const query = ($("#chatSearch")?.value || "").toLowerCase();
  const chats = state.chats.filter((chat) => `${chat.user.displayName} ${chat.user.username}`.toLowerCase().includes(query));
  $("#chatList").innerHTML = chats.map((chat) => {
    const preview = chat.lastMessage ? (chat.lastMessage.type === "text" ? chat.lastMessage.content : `Sent a ${chat.lastMessage.type}`) : "Start a conversation";
    return `<div class="chat-row ${state.selected?.id === chat.user.id ? "active" : ""}" data-chat-id="${chat.user.id}">
      ${avatar(chat.user)}${chat.user.isOnline ? '<i class="online-dot"></i>' : ""}
      <div class="chat-details"><div class="chat-name-line"><strong>${esc(chat.user.displayName)}</strong><time>${timeAgo(chat.lastMessage?.createdAt)}</time></div>
      <div class="chat-preview-line"><span class="chat-preview">${esc(preview)}</span>${chat.unread ? `<b class="unread">${chat.unread}</b>` : ""}</div></div></div>`;
  }).join("");
  $("#emptyChats").classList.toggle("hidden", Boolean(chats.length));
  $$(".chat-row").forEach((row) => row.addEventListener("click", () => {
    const chat = state.chats.find((item) => item.user.id === Number(row.dataset.chatId));
    if (chat) openConversation(chat.user);
  }));
}
async function openConversation(person) {
  state.selected = person;
  renderChats();
  $("#conversation").classList.add("open");
  renderConversationShell();
  await loadConversation(person.id);
}
function renderConversationShell() {
  const person = state.selected;
  $("#conversation").className = "conversation open";
  $("#conversation").innerHTML = `<header class="chat-header"><button class="round-button mobile-only" id="backToChats">‹</button>${avatar(person)}
    <div class="chat-header-info"><strong>${esc(person.displayName)}</strong><span id="presenceLine">${person.isOnline ? "online" : lastSeen(person.lastSeen)}</span></div>
    <div class="chat-header-actions"><button class="round-button" title="More options">•••</button></div></header>
    <div id="messages" class="messages"></div><div id="typingLine" class="typing"></div>
    <div class="composer-wrap"><div id="attachmentName" class="attachment-name hidden"></div><div class="reply-composer">
      <button id="emojiButton" class="composer-button" title="Add emoji">☺</button><button id="attachButton" class="composer-button" title="Attach a file">⊕</button>
      <textarea id="messageInput" rows="1" placeholder="Write a message..." aria-label="Message"></textarea><button id="recordButton" class="composer-button" title="Record voice message">◉</button><button id="sendButton" class="composer-button send" title="Send">↗</button></div></div>`;
  const fileInput = document.createElement("input");
  fileInput.type = "file"; fileInput.id = "fileInput"; fileInput.className = "hidden"; fileInput.accept = "image/*,video/*,audio/*,.pdf,.txt,.zip";
  $("#conversation").appendChild(fileInput);
  $("#backToChats").addEventListener("click", () => $("#conversation").classList.remove("open"));
  $("#sendButton").addEventListener("click", sendMessage);
  $("#messageInput").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } });
  $("#messageInput").addEventListener("input", () => {
    $("#messageInput").style.height = "auto"; $("#messageInput").style.height = `${Math.min(100, $("#messageInput").scrollHeight)}px`;
    api("/api/presence", { method: "POST", body: JSON.stringify({ typingTo: person.id }) }).catch(() => {});
  });
  $("#attachButton").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => { const file = fileInput.files[0]; if (file) { $("#attachmentName").textContent = `Attached: ${file.name}`; $("#attachmentName").classList.remove("hidden"); } });
  $("#emojiButton").addEventListener("click", showEmojiTray);
  $("#recordButton").addEventListener("click", toggleRecording);
}
async function loadConversation(userId, silent = false) {
  if (!state.selected || state.selected.id !== userId) return;
  try {
    const data = await api(`/api/chats/${userId}/messages`);
    const messages = $("#messages");
    if (!messages) return;
    const shouldScroll = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
    messages.innerHTML = data.messages.map(renderMessage).join("") || `<div class="empty-state"><div class="empty-orbit">✦</div><h3>Say hello</h3><p>This is a fresh connection. Start with something easy.</p></div>`;
    if (shouldScroll || !silent) messages.scrollTop = messages.scrollHeight;
    const presence = await api(`/api/chats/${userId}/state`);
    if ($("#presenceLine")) $("#presenceLine").textContent = presence.isOnline ? "online" : lastSeen(presence.lastSeen);
    if ($("#typingLine")) $("#typingLine").textContent = presence.isTyping ? `${state.selected.displayName} is typing…` : "";
    await api(`/api/chats/${userId}/seen`, { method: "POST" }).catch(() => {});
  } catch (error) { if (!silent) toast(error.message, true); }
}
function renderMessage(message) {
  let content = "";
  if (message.type === "text") content = `<div class="bubble">${esc(message.content)}</div>`;
  else if (message.type === "image") content = `<div class="bubble"><img class="message-media" src="${esc(message.fileUrl)}" alt="${esc(message.fileName || "Shared image")}"></div>`;
  else if (message.type === "video") content = `<div class="bubble"><video class="message-media" controls src="${esc(message.fileUrl)}"></video></div>`;
  else if (message.type === "audio") content = `<div class="bubble"><audio controls src="${esc(message.fileUrl)}"></audio></div>`;
  else content = `<div class="bubble file-bubble"><span class="file-icon">▱</span><span><a href="${esc(message.fileUrl)}" download>${esc(message.fileName || "Download file")}</a><small>${formatBytes(message.fileSize)}</small></span></div>`;
  return `<div class="message ${message.mine ? "mine" : ""}">${content}<div class="message-meta"><span>${clock(message.createdAt)}</span>${message.mine ? `<span>${message.seenAt ? "Seen" : "Sent"}</span>` : ""}</div></div>`;
}
function formatBytes(bytes) { if (!bytes) return ""; if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
async function sendMessage() {
  if (!state.selected) return;
  const input = $("#messageInput"); const fileInput = $("#fileInput");
  const content = input.value.trim(); const file = fileInput?.files[0];
  if (!content && !file) return;
  const form = new FormData(); if (content) form.append("content", content); if (file) form.append("file", file);
  $("#sendButton").disabled = true;
  try { await api(`/api/chats/${state.selected.id}/messages`, { method: "POST", body: form }); input.value = ""; input.style.height = "auto"; fileInput.value = ""; $("#attachmentName").classList.add("hidden"); await loadConversation(state.selected.id); await loadChats(true); }
  catch (error) { toast(error.message, true); } finally { $("#sendButton").disabled = false; }
}
function showEmojiTray() {
  const existing = $("#emojiTray"); if (existing) return existing.remove();
  const tray = document.createElement("div"); tray.id = "emojiTray"; tray.style.cssText = "position:absolute;bottom:70px;background:#fff;border:1px solid #e9e8ef;border-radius:10px;padding:10px;display:flex;gap:8px;flex-wrap:wrap;width:190px;box-shadow:0 12px 30px rgba(45,39,91,.12);font-size:20px";
  ["😊", "🙌", "✨", "🤍", "😂", "🥹", "👋", "💬", "🌿", "☕", "🎉", "❤️"].forEach((emoji) => { const button = document.createElement("button"); button.textContent = emoji; button.addEventListener("click", () => { $("#messageInput").value += emoji; tray.remove(); $("#messageInput").focus(); }); tray.appendChild(button); });
  $("#conversation").appendChild(tray);
}
async function toggleRecording() {
  const button = $("#recordButton");
  if (state.recording) { state.mediaRecorder.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia) return toast("Voice recording isn't supported in this browser.", true);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.audioChunks = []; state.mediaRecorder = new MediaRecorder(stream); state.recording = true; button.classList.add("recording"); button.textContent = "■"; toast("Recording voice message… tap the button to stop.");
    state.mediaRecorder.ondataavailable = (event) => state.audioChunks.push(event.data);
    state.mediaRecorder.onstop = async () => { stream.getTracks().forEach((track) => track.stop()); state.recording = false; button.classList.remove("recording"); button.textContent = "◉"; const blob = new Blob(state.audioChunks, { type: "audio/webm" }); const form = new FormData(); form.append("file", blob, `voice-${Date.now()}.webm`); try { await api(`/api/chats/${state.selected.id}/messages`, { method: "POST", body: form }); await loadConversation(state.selected.id); await loadChats(true); } catch (error) { toast(error.message, true); } };
    state.mediaRecorder.start();
  } catch { toast("Microphone access is needed to record a voice message.", true); }
}
function setPanel(panel) {
  state.panel = panel;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.panel === panel));
  ["chats", "discover", "requests"].forEach((name) => $(`#${name}Panel`).classList.toggle("hidden", name !== panel));
  const meta = { chats: ["YOUR SPACE", "Chats"], discover: ["EXPLORE", "Discover"], requests: ["STAY IN THE LOOP", "Requests"] }[panel];
  $("#panelEyebrow").textContent = meta[0]; $("#panelTitle").childNodes[0].textContent = meta[1] + " ";
  if (panel === "requests") loadRequests();
}
function updateCounts() {
  const unread = state.chats.reduce((sum, chat) => sum + chat.unread, 0);
  $("#chatCount").textContent = unread; $("#chatCount").classList.toggle("hidden", !unread);
}
async function searchPeople() {
  const query = $("#peopleSearch").value.trim();
  if (!query) { $("#peopleResults").innerHTML = '<div class="discover-placeholder"><span>✦</span><p>Start typing to discover someone new.</p></div>'; return; }
  try {
    const { people } = await api(`/api/people?q=${encodeURIComponent(query)}`);
    $("#peopleResults").innerHTML = people.length ? people.map((person) => `<div class="person-row">${avatar(person)}<div class="person-meta"><strong>${esc(person.displayName)}</strong><span>@${esc(person.username)} · ${esc(person.bio)}</span></div><button class="small-button" data-add-person="${person.id}">Connect</button></div>`).join("") : '<div class="discover-placeholder"><span>⌕</span><p>No one matched that search yet. Check the spelling and try again.</p></div>';
    $$("[data-add-person]").forEach((button) => button.addEventListener("click", async () => { button.disabled = true; try { await api(`/api/requests/${button.dataset.addPerson}`, { method: "POST" }); button.textContent = "Request sent"; button.classList.add("sent"); toast("Connection request sent."); } catch (error) { toast(error.message, true); button.disabled = false; } }));
  } catch (error) { toast(error.message, true); }
}
async function loadRequests() {
  try {
    const data = await api("/api/requests");
    const incomingPending = data.incoming.filter((item) => item.status === "pending");
    $("#requestCount").textContent = incomingPending.length; $("#requestCount").classList.toggle("hidden", !incomingPending.length);
    $("#incomingRequests").innerHTML = `<div class="request-section-label">New for you</div>${incomingPending.length ? incomingPending.map(renderIncoming).join("") : '<div class="empty-mini">No new requests right now.</div>'}`;
    const outgoing = data.outgoing.filter((item) => item.status === "pending");
    $("#outgoingRequests").innerHTML = `<div class="request-section-label">Sent requests</div>${outgoing.length ? outgoing.map((item) => `<div class="request-row">${avatar(item.user)}<div class="person-meta"><strong>${esc(item.user.displayName)}</strong><span>@${esc(item.user.username)}</span></div><button class="small-button sent" disabled>Pending</button></div>`).join("") : '<div class="empty-mini">Your sent requests will appear here.</div>'}`;
    $$("[data-request-action]").forEach((button) => button.addEventListener("click", () => handleRequest(button.dataset.requestAction, button.dataset.requestId)));
  } catch (error) { toast(error.message, true); }
}
function renderIncoming(item) { return `<div class="request-row">${avatar(item.user)}<div class="person-meta"><strong>${esc(item.user.displayName)}</strong><span>@${esc(item.user.username)} · ${timeAgo(item.createdAt)}</span></div><div class="request-actions"><button class="small-button secondary" data-request-action="decline" data-request-id="${item.id}">Not now</button><button class="small-button" data-request-action="accept" data-request-id="${item.id}">Accept</button></div></div>`; }
async function handleRequest(action, id) { try { await api(`/api/requests/${id}`, { method: "PATCH", body: JSON.stringify({ action }) }); toast(action === "accept" ? "You’re connected — say hello." : "Request declined."); await loadRequests(); await loadChats(); } catch (error) { toast(error.message, true); } }
async function loadNotifications(silent = false) {
  try {
    const { notifications } = await api("/api/notifications");
    const unread = notifications.some((notification) => !notification.isRead);
    $("#notificationDot").classList.toggle("hidden", !unread);
    $("#notificationList").innerHTML = notifications.length ? notifications.map((item) => `<div class="notification-item ${item.isRead ? "" : "unread-item"}"><strong>${esc(item.title)}</strong><p>${esc(item.body)}</p><time>${timeAgo(item.createdAt)}</time></div>`).join("") : '<div class="empty-mini">You’re all caught up.</div>';
  } catch (error) { if (!silent) toast(error.message, true); }
}
function bindGlobalEvents() {
  $$(".auth-tab").forEach((tab) => tab.addEventListener("click", () => switchAuth(tab.dataset.auth)));
  document.addEventListener("click", (event) => { const button = event.target.closest("[data-switch-auth]"); if (button) switchAuth(button.dataset.switchAuth); const panelLink = event.target.closest("[data-panel-link]"); if (panelLink) setPanel(panelLink.dataset.panelLink); });
  $("#authForm").addEventListener("submit", submitAuth);
  $(".show-password").addEventListener("click", (event) => { const input = event.currentTarget.parentElement.querySelector("input"); input.type = input.type === "password" ? "text" : "password"; event.currentTarget.textContent = input.type === "password" ? "Show" : "Hide"; });
  $("#chatSearch").addEventListener("input", renderChats); $("#peopleSearch").addEventListener("input", searchPeople);
  $$(".nav-item").forEach((item) => item.addEventListener("click", () => setPanel(item.dataset.panel)));
  $("#notificationButton").addEventListener("click", async () => { $("#notificationPanel").classList.toggle("hidden"); await api("/api/notifications/read", { method: "POST" }).catch(() => {}); await loadNotifications(true); });
  $("#closeNotifications").addEventListener("click", () => $("#notificationPanel").classList.add("hidden"));
  $("#logoutButton").addEventListener("click", async () => { await api("/api/auth/logout", { method: "POST" }).catch(() => {}); state.user = null; state.selected = null; showAuth(); switchAuth("signin"); });
  $("#mobileMenu").addEventListener("click", () => { $(".sidebar").classList.add("open"); $("#sidebarOverlay").classList.remove("hidden"); });
  $("#mobileCloseSidebar").addEventListener("click", closeSidebar); $("#sidebarOverlay").addEventListener("click", closeSidebar);
}
function closeSidebar() { $(".sidebar").classList.remove("open"); $("#sidebarOverlay").classList.add("hidden"); }
async function init() {
  bindGlobalEvents();
  try { const data = await api("/api/me"); if (data.user) { state.user = data.user; showApp(); } else switchAuth("signin"); } catch { switchAuth("signin"); }
}
init();