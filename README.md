# Mailer

Send email campaigns from your own Gmail address to a list of contacts, and see for every email whether it was sent, delivered, opened, clicked and replied to.

Everything runs on free services:

| Part | Runs on | What it does |
|---|---|---|
| **Web app** | Cloudflare Workers (free plan) | Where you work: write the email, import contacts, read the results. It is also the address the emails point back to, which is how opens and clicks are counted. |
| **Mailer workflow** | GitHub Actions | Every hour, or when you start it: sends the next batch through Gmail, then reads your mailbox for replies and bounces. |
| **Your Gmail** | Google | Emails leave from your real address, and replies arrive in your normal inbox. |

Your contacts and results are stored in a database in your own Cloudflare account. Nothing about them is kept in this repository.

## Set up

This takes about 15 minutes, once. You need a Gmail account, this GitHub repository and a Cloudflare account.

### 1. Gmail: create an app password

1. Turn on 2-Step Verification at <https://myaccount.google.com/security>.
2. Open <https://myaccount.google.com/apppasswords>, create an app password named `Mailer`, and copy the 16 letters it shows.

### 2. Cloudflare: create an account and an API token

1. Sign up at <https://dash.cloudflare.com/sign-up>. No card is needed.
2. Open **Workers & Pages** once. That gives your account its `workers.dev` address.
3. Copy your **Account ID** from the right-hand side of that page.
4. Go to **My Profile > API Tokens > Create Token** and pick the **Edit Cloudflare Workers** template. Add one more permission, **Account / D1 / Edit**. Under Account Resources choose your account, under Zone Resources choose All zones. Create the token and copy it.

### 3. GitHub: add the secrets

In this repository open **Settings > Secrets and variables > Actions** and add these with **New repository secret**:

| Name | Value |
|---|---|
| `GMAIL_USER` | Your Gmail address |
| `GMAIL_APP_PASSWORD` | The app password from step 1 |
| | *(sending from more than one Gmail account instead? See "Send from more than one Gmail account" below — skip these two secrets and use `GMAIL_ACCOUNTS` there instead.)* |
| `CLOUDFLARE_API_TOKEN` | The token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | The Account ID from step 2 |
| `APP_SECRET` | A long password you make up. It is your sign-in to the web app. |

To generate a good `APP_SECRET`:

```
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

### 4. Push the code

```
git add .
git commit -m "Add mailer"
git push -u origin main
```

Open the **Actions** tab and wait for **Test and deploy** to turn green. Open that run: its summary shows the address of your app, like `https://mailer.your-name.workers.dev`.

### 5. Tell the workflow where the app is

Add one more repository secret, `APP_URL`, with that address.

### 6. Sign in

Open the address and sign in with your `APP_SECRET`. Go to **Settings** and fill in your name.

### Recommended: start runs from the app

Without this step, emails only go out when GitHub's own `schedule:` trigger in the Mailer workflow fires, or when you press **Run workflow** on it in the Actions tab by hand. GitHub explicitly documents that trigger as best-effort — it can be delayed or silently stop firing, with no notification. With this step, the app itself reliably starts a run through Cloudflare's own Cron Triggers (a first-class, dependable feature, unlike GitHub's), so sending does not depend on GitHub's scheduler at all. How often is set on the Settings page, under **Minutes between runs** (default 60, checked every 5 minutes). It also makes **Send test**, **Start sending** and **Resume** start a run straight away, and adds the **Run now** button to the app's sidebar.

1. Open <https://github.com/settings/personal-access-tokens/new> (your profile picture > **Settings** > **Developer settings** > **Personal access tokens** > **Fine-grained tokens** > **Generate new token**).
2. Name it `mailer-dispatch`. Pick the longest expiration offered, and note the date: the app stops starting runs when it expires.
3. **Repository access**: choose **Only select repositories** and select this repository.
4. **Permissions**: under repository permissions set **Actions** to **Read and write**. Leave everything else as it is.
5. **Generate token** and copy it. GitHub shows it only once.
6. In this repository open **Settings > Secrets and variables > Actions > New repository secret**, name it `DISPATCH_TOKEN` and paste the token.
7. In the Actions tab open **Test and deploy** and press **Run workflow**, so the app receives the token.

### Optional: send from more than one Gmail account

One account is all most people need. Add more to spread volume across them — each has its own
pace and its own inbox, so one account's size or reputation never affects another's, and if Google
ever restricts one, the others keep working.

1. Create an app password (step 1 above) for each extra Gmail account.
2. Add one repository secret, `GMAIL_ACCOUNTS`, holding all of them — including the first — as JSON:
   ```json
   [
     { "user": "you@gmail.com", "app_password": "aaaa bbbb cccc dddd" },
     { "user": "you.backup@gmail.com", "app_password": "eeee ffff gggg hhhh" }
   ]
   ```
   This replaces `GMAIL_USER` and `GMAIL_APP_PASSWORD` — remove those two secrets, or leave them; once `GMAIL_ACCOUNTS` is set, the workflow uses it instead.
3. In the app, open **Mailboxes**. The first time the workflow runs after this, each address in `GMAIL_ACCOUNTS` appears there on its own, with a starting pace from the same safe defaults a single mailbox gets. Click **Edit** to rename one or change its pace, or **Add mailbox** to register one before the first run.
4. Open each new campaign's **Send from** field and choose which mailbox sends it. With only one mailbox this never needs touching; with more than one, every campaign needs a mailbox chosen before it can send a test or start.

The Mailer workflow runs one job per account in `GMAIL_ACCOUNTS`, in parallel, each with its own 30-minute budget — so adding accounts does not slow the others down. It supports up to 5 accounts out of the box; past that, open [.github/workflows/mailer.yml](.github/workflows/mailer.yml) and add more numbers to the `matrix: index:` list near the top (the comment above it explains why that list is fixed rather than computed from the secret). `SMTP_HOST` and `IMAP_HOST` (see "Another mailbox" below) apply to every account in `GMAIL_ACCOUNTS` alike; mixing Gmail with a different provider in one setup is not supported.

### Optional: find GitHub contacts

The **GitHub contacts** page works through GitHub's developers on its own (there is nothing to configure or type) and collects the name, email, login and profile URL of each one. It searches the user base rather than scanning commit history directly, because a raw commit scan keeps re-encountering the same prolific author's many commits while walking through time, burning the scarce search quota without ever surfacing anyone new. Each person costs at most one email lookup: their public profile email first, which is free, and only when that is not set, exactly one commit search — never more than one per person. Only addresses at well-known webmail providers (Gmail, Outlook, Yahoo, iCloud and similar) are kept, since those are real inboxes someone actually reads; corporate, institutional, bot and placeholder addresses are left out. Profiles that list a location in Asia or Africa are left out too — the free profile lookup above already includes this, so it costs nothing extra; it is still only a best-effort filter, since most profiles never set a location at all and an email address itself carries no country information. Anyone already in your contacts is left out too. It needs its own token, because GitHub only allows this kind of search when signed in.

1. Open <https://github.com/settings/personal-access-tokens/new>.
2. Name it `mailer-scraper`. Pick the longest expiration offered, and note the date: the app stops searching when it expires.
3. **Repository access**: **Public Repositories (read-only)** is enough; no other permissions are needed.
4. **Generate token** and copy it. GitHub shows it only once.
5. In this repository open **Settings > Secrets and variables > Actions > New repository secret**, name it `GH_API_TOKEN` and paste the token.
6. In the Actions tab open **Test and deploy** and press **Run workflow**, so the app receives the token.

Press **Start** and it goes through every GitHub account on its own, oldest accounts first. It keeps going, including while you visit other pages in the app, until it has gone through everyone or you press **Stop**; either way, what it has found so far is kept. Because GitHub allows only a handful of these searches per minute, going through everyone can take a long time — pressing **Start** again after a **Stop** resumes from where it left off (shown as **Resume**) instead of starting over, so stopping to use the results so far never loses progress. **Export CSV** downloads the list, and **Add to contacts** adds everyone found to a list of your choice.

### Optional: find Slack contacts

The **Slack contacts** page works through a Slack workspace's member directory on its own (there is nothing to configure or type) and collects the name, registered email and profile link of every real member — a bot, app, deactivated account or Slackbot itself is left out. Because this reads the actual address each person signed up with, rather than scanning message text for one, it needs a token with the `users:read.email` scope, which Slack treats as sensitive: an app can only get it once a workspace **owner or admin** installs it (a regular member's own token is not enough, even if they generate it themselves). Anyone already in your contacts is left out too.

1. Open <https://api.slack.com/apps> and create a new app (**From scratch**) in the workspace you want to search.
2. Under **OAuth & Permissions**, add the `users:read.email` and `users:read` **User Token Scopes**.
3. **Install to Workspace**, signed in as an owner or admin, and approve it.
4. Copy the **User OAuth Token** (starts with `xoxp-`). Slack shows it on the same page afterwards too, so note the app name in case it needs revoking later.
5. In this repository open **Settings > Secrets and variables > Actions > New repository secret**, name it `SLACK_API_TOKEN` and paste the token.
6. In the Actions tab open **Test and deploy** and press **Run workflow**, so the app receives the token.

Press **Start** and it goes through the entire member directory on its own. It keeps going, including while you visit other pages in the app, until it has gone through everyone or you press **Stop**; either way, what it has found so far is kept. Pressing **Start** again after a **Stop** resumes from where it left off (shown as **Resume**) instead of starting over, so stopping to use the results so far never loses progress. **Export CSV** downloads the list, and **Add to contacts** adds everyone found to a list of your choice.

This only ever covers the one workspace the token belongs to. Searching several separate workspaces needs a token (and a repeat of this setup) for each one; there is no way to search a workspace you are not a member of, or an arbitrary workspace at large — Slack's API has no such thing.

## Using it

1. **Contacts > Import file.** Choose your Excel or CSV file. Check that the right column was recognised as the email address and give the list a name. Every other column is kept and can be used to personalise emails. Each address exists only once in your contacts: before you import, the screen shows which addresses you already have, and those are left out. Capital letters, invisible characters copied from a web page, or a form like `Lee Carter <lee@example.com>` do not make an address count as new. Adding a contact by hand follows the same rule.
2. **Campaigns > New campaign.** Pick the list and, in **Send from**, which mailbox sends it — with only one mailbox set up this is already chosen. Write the subject and the message. **Personalize** inserts fields such as the first name. `{{first_name|there}}` means "the first name, or *there* when it is missing". The image button uploads pictures, and **Button** adds a link styled as a button. **Attach files** adds files that every email carries: up to 5 files, 10 MB in all. Gmail refuses some types, such as `.apk` app installers and `.exe` programs; for those, put the file online and link to it. The preview on the right shows the email filled in for a real contact.
3. **Send test** sends the email to you, so you can read it in a real mailbox first.
4. **Start sending** queues one email for every contact on the list who has never been emailed by this app and is not already waiting in another campaign. Nobody gets a campaign email twice. Leave **How many to send** blank to queue everyone available, or set a number to send to only part of the list now; the rest stay available, so a second campaign (or a duplicate of this one) can reach them later — useful for easing a large, never-emailed list in gradually rather than queuing it all on day one. From here the content and the audience are locked. To change them, duplicate the campaign.
5. Open the campaign to follow the results. **Export** downloads them as a CSV file.

### What the statuses mean

| Status | Meaning | How the app knows |
|---|---|---|
| Queued | Waiting for a run | |
| Sent | Gmail accepted the email | Gmail's answer when sending |
| Delivered | No bounce came back | The mailbox was checked at least five minutes after sending and held no failure notice. Mail servers do not confirm delivery, so this is the strongest signal there is. |
| Opened | The email was viewed | The recipient's mail app loaded a hidden image, or the recipient clicked or replied |
| Clicked | A link was followed | Links pass through the app |
| Replied | The recipient answered | The reply in your mailbox refers to the email it answers. Out-of-office replies are ignored. |
| Bounced | The address did not accept the email | A failure notice arrived in your mailbox. The contact is not emailed again. |
| Not sent | Gmail refused the email, or the contact left first | The contact unsubscribed, bounced or was deleted before their turn |
| Unsubscribed | The recipient used the unsubscribe link, or you marked them on the Contacts page | They are not emailed again |

## Things to know

- **Attachments and spam filters.** A file attached to a first email from someone the reader does not know makes spam filters more careful. When a link to the file would do, it is the safer choice.
- **Opens are an estimate.** Apple Mail loads images by itself, which counts as an open. Mail apps that block images hide real opens. Looking at your own sent copy in Gmail counts too. Replies and clicks are reliable.
- **Gmail's limits.** A personal Gmail account can send to about 500 recipients a day, and Google restricts accounts that send a lot of unwanted email. Each mailbox starts cautiously — a few emails per run, well under 500 a day. Change a mailbox's pace by editing it on the **Mailboxes** page, and raise it slowly; the notice on that page has the detail.
- **Timing.** The workflow runs once an hour, and GitHub can start scheduled runs several minutes late. Statuses update when a run finishes. To run more often, change the `cron` line in [.github/workflows/mailer.yml](.github/workflows/mailer.yml).
- **Actions minutes.** In a private repository each run uses about one of the 2,000 free minutes a month, so hourly runs use roughly 720. Public repositories are not charged, but GitHub switches off their scheduled workflows after 60 days without a commit.
- **GitHub's terms.** GitHub says Actions should not be used for activity unrelated to the software in the repository, and sending marketing email from a workflow is use they could object to. If the workflow is ever disabled, `npm run runner` does the same job from any computer.
- **Replies and "stop".** Replies show up after the next run, because that is when the mailbox is checked. A reply is recognised when it answers your email, and also when the person writes you a new email instead. Replies to test emails are not counted. When someone asks you to stop, select them on the **Contacts** page and press **Unsubscribe**.
- **The law.** Emails end with your message alone by default. In the United States, CAN-SPAM asks marketing email to carry a postal address and a way to opt out: turn on **Settings > Add a footer to every email** for both. The EU, the UK and Canada generally require permission before the first email. Whether you may email someone is up to you.
- **Another mailbox.** The workflow uses Gmail's servers by default. A mailbox from another provider with SMTP and IMAP access works if you set `SMTP_HOST` and `IMAP_HOST` in the `env` block of `.github/workflows/mailer.yml`, with its login as `GMAIL_USER` and `GMAIL_APP_PASSWORD` (or in `GMAIL_ACCOUNTS` — see "Send from more than one Gmail account" above, though `SMTP_HOST`/`IMAP_HOST` then apply to every account there, not just one).

## Development

```
npm install
copy app\.dev.vars.example app\.dev.vars
npm run dev
```

The app is then at <http://localhost:8787>, with a local database. Sign in with the secret from `app/.dev.vars`.

```
npm test
```

runs the tests. They start the real Worker in a local Workers runtime and send through a local stand-in for Gmail, so they need no accounts.

To run the mailer from your computer, against the local app or the deployed one, copy `.env.example` to `.env`, fill it in and run `npm run runner`.

### Layout

```
app/                 the web app, a Cloudflare Worker
  src/               the API, the tracking endpoints and the database schema
  public/            the browser app, plain JavaScript with no build step
  public/shared/     builds the email itself, used by the preview and by the mailer
runner/              what the Mailer workflow runs: send over SMTP, read the mailbox over IMAP
scripts/             deploy, and copying browser libraries out of node_modules
test/                the tests
.github/workflows/   deploy.yml (test and deploy) and mailer.yml (send and check)
```
