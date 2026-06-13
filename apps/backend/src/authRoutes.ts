import { Router, Request, Response } from 'express';
import { RoomPermissionService } from './permissions.js';
import { getSupabaseClient } from './supabaseClient.js';

export function sendError(res: Response, error: any) {
  const statusCode = error.statusCode || error.status || 500;
  res.status(statusCode).json({ error: error.message || 'Internal Server Error' });
}

export function requireNonEmptyString(value: any, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    const err = new Error(`${fieldName} must be a non-empty string`) as any;
    err.statusCode = 400;
    throw err;
  }
  return value.trim();
}

export function createAuthRouter(permissions: RoomPermissionService): Router {
  const router = Router();

  // POST /auth/login { email, password } → { accessToken, user }
  router.post('/auth/login', async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;
      const cleanEmail = requireNonEmptyString(email, 'email');
      const cleanPassword = requireNonEmptyString(password, 'password');

      const { user, token } = await permissions.login(cleanEmail, cleanPassword);
      res.json({ accessToken: token, user });
    } catch (error) {
      sendError(res, error);
    }
  });

  // GET /me (Authorization: Bearer) → { user }
  router.get('/me', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      const user = await permissions.authenticate(authHeader);
      res.json({ user });
    } catch (error) {
      sendError(res, error);
    }
  });

  // POST /me/profile { name } → { user }
  router.post('/me/profile', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      const user = await permissions.authenticate(authHeader);

      const { name } = req.body;
      const cleanName = requireNonEmptyString(name, 'name');

      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error('Supabase client not initialized');
      }

      // Update public.users table profile
      const { error: dbError } = await supabase
        .from('users')
        .update({ name: cleanName })
        .eq('id', user.id);

      if (dbError) throw dbError;

      // Update auth user metadata so subsequent token/auth maps have updated metadata
      const { data: { user: updatedAuthUser }, error: authError } = await supabase.auth.admin.updateUserById(
        user.id,
        { user_metadata: { name: cleanName } }
      );

      if (authError) throw authError;

      const updatedUser = permissions.mapAuthUser(updatedAuthUser);
      res.json({ user: updatedUser });
    } catch (error) {
      sendError(res, error);
    }
  });

  // GET /auth/github?port=<n> → redirect to Supabase GitHub OAuth URL
  router.get('/auth/github', async (req: Request, res: Response) => {
    try {
      const port = req.query.port;
      if (!port) {
        return res.status(400).json({ error: 'Port query parameter is required' });
      }

      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error('Supabase client not initialized');
      }

      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'github',
        options: {
          redirectTo: `${req.protocol}://${req.get('host')}/auth/callback?port=${port}`
        }
      });

      if (error) throw error;

      if (data?.url) {
        res.redirect(data.url);
      } else {
        res.status(500).json({ error: 'OAuth redirect URL could not be generated' });
      }
    } catch (error) {
      sendError(res, error);
    }
  });

  // GET /auth/callback → serve HTML loading page that handles both PKCE (code in query) and implicit (access_token in hash) flows
  router.get('/auth/callback', (req: Request, res: Response) => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Authenticating...</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      background-color: #0f172a;
      color: #f8fafc;
    }
    .spinner {
      border: 4px solid rgba(255, 255, 255, 0.1);
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border-left-color: #38bdf8;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    p {
      margin-top: 16px;
      font-size: 16px;
      color: #94a3b8;
    }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <p>Completing authentication, please wait...</p>
  <script>
    (async function() {
      const urlParams = new URLSearchParams(window.location.search);
      const hashParams = new URLSearchParams(window.location.hash.substring(1));
      
      const port = urlParams.get('port') || '3000';
      const code = urlParams.get('code');
      const accessToken = hashParams.get('access_token');
      
      if (code) {
        // PKCE flow
        window.location.href = '/auth/exchange?code=' + encodeURIComponent(code) + '&port=' + encodeURIComponent(port);
      } else if (accessToken) {
        // Implicit flow
        try {
          const res = await fetch('/me', {
            headers: {
              'Authorization': 'Bearer ' + accessToken
            }
          });
          if (!res.ok) throw new Error('Failed to fetch user info');
          const data = await res.json();
          const userStr = encodeURIComponent(JSON.stringify(data.user));
          window.location.href = 'http://localhost:' + port + '/callback?accessToken=' + encodeURIComponent(accessToken) + '&user=' + userStr;
        } catch (err) {
          document.body.innerHTML = '<p style="color: #ef4444;">Authentication failed: ' + err.message + '</p>';
        }
      } else {
        document.body.innerHTML = '<p style="color: #ef4444;">Authentication failed: Missing code or access token.</p>';
      }
    })();
  </script>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  });

  // GET /auth/exchange?code=<c>&port=<n> → exchange code for session, redirect to http://localhost:<port>/callback?accessToken=...&user=...
  router.get('/auth/exchange', async (req: Request, res: Response) => {
    try {
      const code = req.query.code;
      const port = req.query.port;

      const cleanCode = requireNonEmptyString(code, 'code');
      const cleanPort = requireNonEmptyString(port, 'port');

      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error('Supabase client not initialized');
      }

      const { data, error } = await supabase.auth.exchangeCodeForSession(cleanCode);
      if (error || !data.session || !data.user) {
        throw error || new Error('Failed to exchange code for session');
      }

      const mappedUser = permissions.mapAuthUser(data.user);
      await permissions.ensureUserProfile(data.user);

      const userStr = encodeURIComponent(JSON.stringify(mappedUser));
      res.redirect(`http://localhost:${cleanPort}/callback?accessToken=${data.session.access_token}&user=${userStr}`);
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
