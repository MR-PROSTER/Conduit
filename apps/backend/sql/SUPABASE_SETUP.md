# Setup Guide for Supabase and Cloudflare R2 (Conduit)

Follow these steps to set up Supabase (for database), Cloudflare R2 (for file storage), and run the application.

---

### Step 1: Create Supabase Project

1. Go to [Supabase](https://supabase.com/) and sign in or sign up.
2. Click **New Project** and select your organization.
3. Enter a project name (e.g., `Conduit`), set a secure database password, and select a region close to you.
4. Click **Create new project** and wait for database provisioning to complete.

---

### Step 2: Run the SQL File in SQL Editor

1. In the Supabase Dashboard, navigate to the **SQL Editor** from the left navigation panel.
2. Click **New query** (or **New blank query**).
3. Copy the entire contents of `conduit_full_schema.sql` and paste it into the editor.
4. Click **Run** (or press `Cmd + Enter` / `Ctrl + Enter`). The script has been structured to run directly without triggering the "Run with RLS" or "Run without RLS" modal prompt. (If you ever do see the prompt, choose **"Run without RLS"**).
5. Ensure the query executes successfully.

---

### Step 3: Verify 9 Tables in Dashboard

1. Go to the **Table Editor** on the left panel in Supabase.
2. Verify that all 9 tables have been created under the `public` schema:
   1. `users`
   2. `rooms`
   3. `room_members`
   4. `invitations`
   5. `sessions`
   6. `drafts`
   7. `draft_filesystem_ops`
   8. `chat_threads`
   9. `chat_messages`

---

### Step 3b: Set Up Cloudflare R2 Bucket

1. Log in to your [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Navigate to **R2** in the left sidebar.
3. Click **Create bucket**.
4. Name your bucket `drafts` (or any custom name) and select your preferred location/region.
5. Once created, click on your account name/R2 overview to obtain:
   - **Account ID** (used to build your Endpoint URL: `https://<account_id>.r2.cloudflarestorage.com`)
6. Go to **R2 -> Manage R2 API Tokens** on the right side.
7. Click **Create API Token**.
8. Select permissions: **Edit** (Read & Write permissions are required).
9. Click **Create API Token** and copy the generated credentials:
   - **Access Key ID**
   - **Secret Access Key**

---

### Step 4: Get Supabase API Keys

1. In the Supabase Dashboard, go to **Project Settings** (gear icon) -> **API** in the left panel.
2. Copy the following credentials:
   - **Project URL** (under Project API keys / URL)
   - **Anon key** (under `anon` `public`)
   - **Service role key** (under `service_role` `secret`)

---

### Step 5: Create Backend Environment File (`apps/backend/.env`)

1. Create or edit the `.env` file in the [apps/backend/](file:///Users/ajju/Desktop/Projects/Conduit/apps/backend/) directory.
2. Configure it with your Supabase credentials and your Cloudflare R2 credentials:

   ```env
   PORT=4000

   # Supabase Credentials
   SUPABASE_URL=YOUR_SUPABASE_PROJECT_URL
   SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
   SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY

   # Cloudflare R2 Credentials
   CLOUDFLARE_R2_ACCESS_KEY_ID=YOUR_R2_ACCESS_KEY_ID
   CLOUDFLARE_R2_SECRET_ACCESS_KEY=YOUR_R2_SECRET_ACCESS_KEY
   CLOUDFLARE_R2_ENDPOINT=https://YOUR_CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com
   CLOUDFLARE_R2_BUCKET_NAME=drafts
   ```

---

### Step 6: Configure VS Code `settings.json`

1. Create or edit the `.vscode/settings.json` file at the root of the workspace.
2. Add or update the following configuration properties:
   ```json
   {
     "websocketUrl": "ws://localhost:4000",
     "backendUrl": "http://localhost:4000"
   }
   ```

---

### Step 7: Start Backend

1. Open your terminal at the root of the project.
2. Build and start the backend:
   ```bash
   pnpm --filter @conduit/backend build && pnpm --filter @conduit/backend start
   ```

---

### Step 8: Launch Extension

1. In VS Code, open the **Run and Debug** view (`Ctrl+Shift+D` or `Cmd+Shift+D`).
2. Select the configuration to launch the extension (typically named **Launch Extension** or **Extension**).
3. Press **F5** to start a new Extension Development Host window.

---

### Step 9: Add AI API Key in the AI Panel Settings

1. In the newly launched Extension Development Host, open the **AI Panel** view/sidebar.
2. Open the **Settings** section in the AI Panel.
3. Add/configure your AI API Key to enable AI assistance features.
