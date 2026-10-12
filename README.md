# Mailer

Send email campaigns from your own Gmail address to a list of contacts, and see for every email whether it was sent, delivered, opened, clicked and replied to.

Everything runs on free services:

| Part | Runs on | What it does |
|---|---|---|
| **Web app** | Cloudflare Workers (free plan) | Where you work: write the email, import contacts, read the results. It is also the address the emails point back to, which is how opens, clicks and unsubscribes are counted. |
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

Open the address and sign in with your `APP_SECRET`. Go to **Settings** and fill in your name and postal address.

### Optional: start runs from the app

Without this step, emails go out with the next hourly run, or when you press **Run workflow** on the Mailer workflow in the Actions tab. With it, **Send test** and **Start sending** go out within a minute or two.

1. On GitHub open **Settings > Developer settings > Personal access tokens > Fine-grained tokens** and generate a token that can access only this repository, with the repository permission **Actions: Read and write**.
2. Add it as the repository secret `DISPATCH_TOKEN`.
3. In the Actions tab run **Test and deploy** once more, so the app receives the token.

## Using it

1. **Contacts > Import file.** Choose your Excel or CSV file. Check that the right column was recognised as the email address and give the list a name. Every other column is kept and can be used to personalise emails. Addresses you already have are skipped, so importing a file twice does no harm.
2. **Campaigns > New campaign.** Pick the list, write the subject and the message. **Personalize** inserts fields such as the first name. `{{first_name|there}}` means "the first name, or *there* when it is missing". The image button uploads pictures, and **Button** adds a link styled as a button. The preview on the right shows the email filled in for a real contact.
3. **Send test** sends the email to you, so you can read it in a real mailbox first.
4. **Start sending** queues one email for every active contact on the list. From here the content is locked. To change it, duplicate the campaign.
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
| Unsubscribed | The recipient used the unsubscribe link | They are not emailed again |

## Things to know

- **Opens are an estimate.** Apple Mail loads images by itself, which counts as an open. Mail apps that block images hide real opens. Looking at your own sent copy in Gmail counts too. Replies and clicks are reliable.
- **Gmail's limits.** A personal Gmail account can send to about 500 recipients a day, and Google restricts accounts that send a lot of unwanted email. The defaults are 25 emails per run and 100 per day. Change them under **Settings > Sending pace**, and raise them slowly.
- **Timing.** The workflow runs once an hour, and GitHub can start scheduled runs several minutes late. Statuses update when a run finishes. To run more often, change the `cron` line in [.github/workflows/mailer.yml](.github/workflows/mailer.yml).
- **Actions minutes.** In a private repository each run uses about one of the 2,000 free minutes a month, so hourly runs use roughly 720. Public repositories are not charged, but GitHub switches off their scheduled workflows after 60 days without a commit.
- **GitHub's terms.** GitHub says Actions should not be used for activity unrelated to the software in the repository, and sending marketing email from a workflow is use they could object to. If the workflow is ever disabled, `npm run runner` does the same job from any computer.
- **The law.** The app adds an unsubscribe link and your postal address to every email, and never emails someone who unsubscribed or bounced. Whether you may email someone at all is up to you. In the United States, CAN-SPAM allows unrequested marketing email when it is honest and has those two things. The EU, the UK and Canada generally require permission first.
- **Another mailbox.** The workflow uses Gmail's servers by default. Any mailbox with SMTP and IMAP access works if you set `SMTP_HOST` and `IMAP_HOST` in the `env` block of the workflow file, with that mailbox's login in `GMAIL_USER` and `GMAIL_APP_PASSWORD`.

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
