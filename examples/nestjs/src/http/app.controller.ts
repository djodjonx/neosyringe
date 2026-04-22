import { Controller, Get, Header } from '@nestjs/common';

const HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NeoSyringe × NestJS — Cats API</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem 1rem;
    }
    header {
      text-align: center;
      margin-bottom: 2rem;
    }
    header h1 { font-size: 1.75rem; font-weight: 700; color: #f8fafc; }
    header p  { color: #94a3b8; margin-top: .4rem; font-size: .9rem; }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 1.5rem;
      width: 100%;
      max-width: 640px;
      margin-bottom: 1.5rem;
    }
    .card h2 { font-size: 1rem; font-weight: 600; color: #cbd5e1; margin-bottom: 1rem; }
    form { display: flex; flex-direction: column; gap: .75rem; }
    .row { display: flex; gap: .75rem; }
    input {
      background: #0f172a;
      border: 1px solid #475569;
      border-radius: 8px;
      color: #f1f5f9;
      padding: .55rem .75rem;
      font-size: .9rem;
      flex: 1;
      outline: none;
      transition: border-color .15s;
    }
    input:focus { border-color: #6366f1; }
    input[type=number] { width: 90px; flex: none; }
    button {
      padding: .55rem 1.2rem;
      border: none;
      border-radius: 8px;
      font-size: .9rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity .15s;
    }
    button:hover { opacity: .85; }
    .btn-primary { background: #6366f1; color: #fff; }
    .btn-danger  { background: #ef4444; color: #fff; padding: .3rem .7rem; font-size: .8rem; }
    #status {
      font-size: .8rem;
      color: #94a3b8;
      min-height: 1.2em;
      margin-top: .25rem;
    }
    table { width: 100%; border-collapse: collapse; }
    th {
      text-align: left;
      font-size: .75rem;
      text-transform: uppercase;
      letter-spacing: .05em;
      color: #64748b;
      padding: .5rem .75rem;
      border-bottom: 1px solid #334155;
    }
    td {
      padding: .65rem .75rem;
      font-size: .9rem;
      border-bottom: 1px solid #1e293b;
    }
    tr:last-child td { border-bottom: none; }
    #empty {
      text-align: center;
      color: #475569;
      padding: 1.5rem 0;
      font-size: .9rem;
    }
    .badge {
      display: inline-block;
      background: #312e81;
      color: #a5b4fc;
      border-radius: 999px;
      font-size: .7rem;
      padding: .15rem .55rem;
      font-weight: 600;
    }
    a { color: #818cf8; text-decoration: none; font-size: .8rem; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <header>
    <h1>NeoSyringe × NestJS</h1>
    <p>Compile-time DI — zero runtime overhead &nbsp;·&nbsp; <a href="https://djodjonx.github.io/neosyringe/" target="_blank">docs ↗</a></p>
  </header>

  <div class="card">
    <h2>Add a cat</h2>
    <form id="createForm">
      <input id="name"  type="text"   placeholder="Name"  required />
      <div class="row">
        <input id="age"   type="number" placeholder="Age"   min="0" required />
        <input id="breed" type="text"   placeholder="Breed" required style="flex:1" />
        <button type="submit" class="btn-primary">Add</button>
      </div>
      <div id="status"></div>
    </form>
  </div>

  <div class="card">
    <h2>Cats <span class="badge" id="count">0</span></h2>
    <table>
      <thead>
        <tr>
          <th>Name</th><th>Age</th><th>Breed</th><th></th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
    <div id="empty">No cats yet — add one above.</div>
  </div>

  <script>
    const status = document.getElementById('status');
    const count  = document.getElementById('count');
    const tbody  = document.getElementById('tbody');
    const empty  = document.getElementById('empty');

    async function loadCats() {
      const res  = await fetch('/cats');
      const cats = await res.json();
      count.textContent = cats.length;
      tbody.innerHTML   = '';
      empty.style.display = cats.length ? 'none' : 'block';
      cats.forEach(cat => {
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td>\${esc(cat.name)}</td>
          <td>\${cat.age}</td>
          <td>\${esc(cat.breed)}</td>
          <td><button class="btn-danger" data-id="\${cat.id}">Delete</button></td>
        \`;
        tbody.appendChild(tr);
      });
    }

    tbody.addEventListener('click', async e => {
      const btn = e.target.closest('[data-id]');
      if (!btn) return;
      btn.disabled = true;
      await fetch(\`/cats/\${btn.dataset.id}\`, { method: 'DELETE' });
      loadCats();
    });

    document.getElementById('createForm').addEventListener('submit', async e => {
      e.preventDefault();
      status.textContent = 'Adding…';
      const body = {
        name:  document.getElementById('name').value.trim(),
        age:   Number(document.getElementById('age').value),
        breed: document.getElementById('breed').value.trim(),
      };
      const res = await fetch('/cats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        status.textContent = 'Cat added!';
        e.target.reset();
        loadCats();
        setTimeout(() => status.textContent = '', 2000);
      } else {
        const err = await res.json().catch(() => ({}));
        status.textContent = err.message ?? 'Error';
      }
    });

    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    loadCats();
  </script>
</body>
</html>`;

@Controller()
export class AppController {
  @Get()
  @Header('Content-Type', 'text/html')
  index(): string {
    return HTML;
  }
}
