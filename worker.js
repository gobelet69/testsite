export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const method = req.method;

    // --- 1. AUTHENTICATION (Basic Auth) ---
    const auth = req.headers.get("Authorization");
    
    // Config (Fallback to defaults if env vars missing)
    const AD_U = env.ADMIN_USER || "admin", AD_P = env.ADMIN_PASS || "admin";
    const GU_U = env.GUEST_USER || "guest", GU_P = env.GUEST_PASS || "guest";

    if (!auth) return requestAuth();

    // Decode Base64
    const creds = atob(auth.split(" ")[1]).split(":");
    const user = creds[0], pass = creds[1];

    // Determine Role
    let role = null; // 'admin' | 'guest'
    if (user === AD_U && pass === AD_P) role = 'admin';
    else if (user === GU_U && pass === GU_P) role = 'guest';
    else return requestAuth(); // Wrong password -> Ask again

    // --- 2. ROUTING ---

    // A. UPLOAD (PUT /upload/filename.pdf) - ADMIN ONLY
    if (method === "PUT" && url.pathname.startsWith("/upload/")) {
      if (role !== 'admin') return new Response("Guest cannot upload", { status: 403 });
      
      const filename = decodeURIComponent(url.pathname.replace("/upload/", ""));
      // Save to R2
      await env.PDF_BUCKET.put(filename, req.body);
      return new Response("OK");
    }

    // B. DOWNLOAD (GET /files/filename.pdf)
    if (method === "GET" && url.pathname.startsWith("/files/")) {
      const filename = decodeURIComponent(url.pathname.replace("/files/", ""));
      const file = await env.PDF_BUCKET.get(filename);
      if (!file) return new Response("Not Found", { status: 404 });

      const headers = new Headers();
      file.writeHttpMetadata(headers);
      headers.set("etag", file.httpEtag);
      return new Response(file.body, { headers });
    }

    // C. DELETE (DELETE /files/filename.pdf) - ADMIN ONLY
    if (method === "DELETE" && url.pathname.startsWith("/files/")) {
       if (role !== 'admin') return new Response("Forbidden", { status: 403 });
       const filename = decodeURIComponent(url.pathname.replace("/files/", ""));
       await env.PDF_BUCKET.delete(filename);
       return new Response("Deleted");
    }

    // D. HOMEPAGE (GET /) - List Files
    if (url.pathname === "/") {
      // Fetch list from R2
      const list = await env.PDF_BUCKET.list();
      
      // Generate HTML
      return new Response(renderHTML(list.objects, role, user), {
        headers: { "Content-Type": "text/html" }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};

function requestAuth() {
  return new Response("🔒 Login Required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Secure Cloud"' }
  });
}

// --- 3. HTML GENERATOR (<14KB Optimized) ---
function renderHTML(files, role, user) {
  // Sort files by newest
  files.sort((a, b) => b.uploaded - a.uploaded);

  const fileRows = files.map(f => `
    <li class="row">
      <a href="/files/${encodeURIComponent(f.key)}" target="_blank" class="file-link">
        📄 ${f.key} <small>(${(f.size/1024).toFixed(1)} KB)</small>
      </a>
      ${role === 'admin' ? `<button onclick="del('${f.key}')" class="del-btn">×</button>` : ''}
    </li>
  `).join('');

  const uploadSection = role === 'admin' ? `
    <div class="card upload-box">
      <h3>📤 Upload PDF</h3>
      <input type="file" id="f" accept=".pdf">
      <button onclick="up()" id="upBtn">Upload</button>
      <div id="status"></div>
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cloud Files</title>
<style>
:root{--bg:#111;--fg:#eee;--acc:#0f0;--card:#222}
body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--fg);max-width:600px;margin:0 auto;padding:20px}
h1{border-bottom:1px solid #333;padding-bottom:10px;display:flex;justify-content:space-between}
.badge{font-size:12px;background:var(--acc);color:#000;padding:2px 6px;border-radius:4px;vertical-align:middle}
.card{background:var(--card);padding:15px;border-radius:6px;margin-bottom:20px;border:1px solid #333}
ul{list-style:none;padding:0}
.row{display:flex;justify-content:space-between;padding:10px;border-bottom:1px solid #333;align-items:center}
.row:hover{background:#1a1a1a}
a{color:var(--fg);text-decoration:none} a:hover{color:var(--acc)}
small{color:#888;margin-left:5px}
button{cursor:pointer;background:#444;color:#fff;border:none;padding:5px 10px;border-radius:4px}
button:hover{background:#666}
.del-btn{background:#f00;font-weight:bold;padding:2px 8px}
</style>
</head>
<body>
  <h1>
    <span>🗄️ File Vault</span>
    <span class="badge">${user}</span>
  </h1>

  ${uploadSection}

  <div class="card">
    <h3>Available Files (${files.length})</h3>
    <ul>${fileRows || '<li style="padding:10px;color:#666">No files yet.</li>'}</ul>
  </div>

<script>
async function up() {
  const inp = document.getElementById('f');
  const btn = document.getElementById('upBtn');
  const st = document.getElementById('status');
  
  if(!inp.files.length) return alert('Select a file');
  
  const file = inp.files[0];
  btn.innerText = 'Uploading...'; btn.disabled = true;
  
  try {
    const res = await fetch('/upload/' + encodeURIComponent(file.name), {
      method: 'PUT',
      body: file
    });
    if(res.ok) {
      st.innerHTML = '<span style="color:#0f0">Done! Reloading...</span>';
      setTimeout(()=>window.location.reload(), 500);
    } else {
      throw new Error('Failed');
    }
  } catch(e) {
    alert('Error uploading');
    btn.innerText = 'Upload'; btn.disabled = false;
  }
}

async function del(name) {
  if(!confirm('Delete ' + name + '?')) return;
  await fetch('/files/' + encodeURIComponent(name), { method: 'DELETE' });
  window.location.reload();
}
</script>
</body>
</html>`;
}