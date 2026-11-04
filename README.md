# AUTO SIGN — Render + PostgreSQL

The app now stores users, students, attendance, payments, and notifications in PostgreSQL.

## Deploy on Render

1. Upload this folder to a GitHub repository.
2. In Render select **New → Blueprint**, then select that repository.
3. Render reads `render.yaml`, creates the web service and `auto-sign-db`, then injects its database connection as `DATABASE_URL`.
4. Deploy and open the public URL.

This uses Render's documented `fromDatabase.connectionString` Blueprint configuration: [Render Blueprint docs](https://render.com/docs/blueprint-spec).

## Demo accounts

- Teacher: `teacher@autosign.tz` / `autosign123`
- Parent: `parent@autosign.tz` / `autosign123`

Change the demo credentials before a real launch. Parents added by the teacher begin with `autosign123`.
