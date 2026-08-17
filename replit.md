# Harkly

Harkly is a calm, mobile-friendly messaging app with a navy, white, black, and pink visual system. It includes:

- Secure account creation and sign-in with bcrypt password hashing
- SQLite persistence for users, connection requests, messages, notifications, and file metadata
- Search by display name or `@username`
- Connection request and acceptance flow
- Recent chats, unread counts, notifications, online/last-seen state, typing state, and message seen state
- Text, emoji, image, video, file, and browser voice-message support

## Run

```bash
npm run dev
```

The app listens on port 5000. The SQLite database is created at `data/harkly.db`, and uploads are stored in `uploads/`. Set `SESSION_SECRET` in the environment for a stable signed session cookie in production; the app uses a secure generated fallback for local development.

## User preferences

- Keep the interface basic but polished, calm, and easy to use.
- Prefer white, black, navy blue, and pink accents with glass/frosted effects only where they improve hierarchy.
- Preserve the current Node/Express/SQLite structure rather than migrating the project to another stack.