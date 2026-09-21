# Firebase setup — do this once

You need a Firebase project so users can register, sign in with Google, and so you get a
dashboard of who is using the app. It is free: the Spark plan covers unlimited email/Google
sign-ins and about 20,000 database writes a day, which is far more than this app produces.

Takes about 10 minutes. At the end you paste 4 values into `src/config.js`.

---

## 1. Create the project

1. Go to <https://console.firebase.google.com> and click **Add project**.
2. Name it `whatsapp-bulk-sender` (any name works).
3. Google Analytics: **turn it off**. You do not need it and it adds a consent burden.
4. Click **Create project**.

## 2. Turn on the sign-in methods

In the left sidebar: **Build → Authentication → Get started**.

Under the **Sign-in method** tab, enable two providers:

- **Email/Password** → toggle *Enable* → Save.
- **Google** → toggle *Enable* → pick a support email → Save.

## 3. Create the database

**Build → Firestore Database → Create database**.

1. Choose a location close to your users (`asia-south1` for India).
2. Start in **production mode** (we replace the rules in step 6 anyway).

## 4. Get your app config

1. Click the **gear icon → Project settings**.
2. Scroll to **Your apps** and click the **web** icon (`</>`).
3. Nickname it `desktop-app`, do **not** tick Firebase Hosting, click **Register app**.
4. You get a `firebaseConfig` block. You need three values from it:
   - `apiKey`
   - `authDomain`
   - `projectId`

## 5. Get the Google client ID (for the Google button)

Firebase already made one for you when you enabled Google sign-in.

1. Still in **Project settings**, go to the **General** tab and note your project.
2. Open <https://console.cloud.google.com/apis/credentials> and pick the same project.
3. Under **OAuth 2.0 Client IDs** you will see one named **Web client (auto created by Google Service)**.
4. Click it and copy the **Client ID** (ends in `.apps.googleusercontent.com`).
5. **Important:** in that same screen, under **Authorised redirect URIs**, click **Add URI** and add:
   ```
   http://localhost:3000/api/auth/google/callback
   ```
   Then add a few fallbacks in case port 3000 is busy on a user's machine:
   ```
   http://localhost:3001/api/auth/google/callback
   http://localhost:3002/api/auth/google/callback
   http://localhost:3003/api/auth/google/callback
   ```
   Click **Save**.

> Desktop apps cannot keep a client secret private, so this flow uses PKCE instead.
> The client ID is not sensitive — it ships inside every copy of the app by design.

## 6. Lock down the database

**Firestore Database → Rules**, replace everything with the contents of
[`firestore.rules`](firestore.rules) in this repo, then **Publish**.

Those rules say: a signed-in user may write only their own record, and only *you*
(your admin email) may read everyone's. Without this, any user could read every other
user's data. Do not skip it.

Open `firestore.rules` and change this line to your own email before publishing:

```
function isAdmin() {
  return request.auth.token.email == 'tools@akoi.in';
}
```

## 7. Paste the values into the app

Open `src/config.js` and fill in:

```js
firebase: {
  apiKey: 'AIza...',
  authDomain: 'your-project.firebaseapp.com',
  projectId: 'your-project',
  googleClientId: '....apps.googleusercontent.com',
},
adminEmail: 'tools@akoi.in',
```

Then rebuild the installer:

```
npm run dist
```

---

## What gets sent to Firebase

Only counts and account info. Never contacts, phone numbers, names or message text —
those never leave the user's computer.

| Sent | Not sent |
|---|---|
| Email address, display name | Contact lists |
| Sign-in and app-open times | Phone numbers |
| Number of campaigns run | Message text |
| Number of messages sent / failed / skipped | Attachments |
| App version, OS | The WhatsApp session |

Passwords are never sent to you and never stored by you — Firebase handles them, so a
breach of your dashboard cannot leak anyone's password.

## Until you finish this

The app falls back to local-only accounts and keeps working exactly as it does now.
Nothing breaks while `src/config.js` is empty — you just get no dashboard.
