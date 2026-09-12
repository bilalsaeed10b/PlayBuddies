import http from 'http';
import fs from 'fs';
import path from 'path';

const RULES_PATH = path.join(process.cwd(), 'games', 'battle-of-pirates', 'src', 'game', 'rules.ts');
const SPECIALS_PATH = path.join(process.cwd(), 'games', 'battle-of-pirates', 'src', 'game', 'specials.ts');

const CARD_IDS = ['round', 'chain', 'grape', 'mortar', 'firebomb', 'bore', 'patch', 'twin', 'broadside', 'keg'];

function parseRules() {
  const content = fs.readFileSync(RULES_PATH, 'utf-8');
  const specialsContent = fs.readFileSync(SPECIALS_PATH, 'utf-8');
  
  const cards = {};
  const getCardVal = (cardId, key) => {
    const blockRegex = new RegExp(`${cardId}:\\s*\\{[^}]*?\\}`, 's');
    const blockMatch = content.match(blockRegex);
    if (blockMatch) {
      const valMatch = blockMatch[0].match(new RegExp(`${key}:\\s*([\\d.]+)`));
      return valMatch ? valMatch[1] : null;
    }
    return null;
  };
  
  for (const id of CARD_IDS) {
    cards[`${id}_damage`] = getCardVal(id, 'damage');
    cards[`${id}_splashDamage`] = getCardVal(id, 'splashDamage');
    if (id === 'patch') {
      cards[`${id}_heal`] = getCardVal(id, 'heal');
    }
  }
  
  const specials = {
    torpedo: specialsContent.match(/torpedo:\s*\{[^}]*amount:\s*([\d.]+)/)?.[1] || 25,
    acidRain: specialsContent.match(/acid-rain':\s*\{[^}]*amount:\s*([\d.]+)/)?.[1] || 15,
    heal: specialsContent.match(/heal:\s*\{[^}]*amount:\s*([\d.]+)/)?.[1] || 30
  };

  return { cards, specials };
}

function updateRules(data) {
  let content = fs.readFileSync(RULES_PATH, 'utf-8');
  let specialsContent = fs.readFileSync(SPECIALS_PATH, 'utf-8');

  const setCardVal = (cardId, key, val) => {
    if (val === undefined || val === null || val === '') return;
    const blockRegex = new RegExp(`(${cardId}:\\s*\\{[^}]*?)(${key}:\\s*)([\\d.]+)`, 's');
    content = content.replace(blockRegex, `$1$2${val}`);
  };

  for (const id of CARD_IDS) {
    setCardVal(id, 'damage', data.cards?.[`${id}_damage`]);
    setCardVal(id, 'splashDamage', data.cards?.[`${id}_splashDamage`]);
  }
  setCardVal('patch', 'heal', data.cards?.['patch_heal']);

  if (data.specials?.torpedo) {
    specialsContent = specialsContent.replace(/(torpedo:\s*\{[^}]*amount:\s*)([\d.]+)/, `$1${data.specials.torpedo}`);
  }
  if (data.specials?.acidRain) {
    specialsContent = specialsContent.replace(/(acid-rain':\s*\{[^}]*amount:\s*)([\d.]+)/, `$1${data.specials.acidRain}`);
  }
  if (data.specials?.heal) {
    specialsContent = specialsContent.replace(/(heal:\s*\{[^}]*amount:\s*)([\d.]+)/, `$1${data.specials.heal}`);
  }

  fs.writeFileSync(RULES_PATH, content, 'utf-8');
  fs.writeFileSync(SPECIALS_PATH, specialsContent, 'utf-8');
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    const data = parseRules();
    
    // Generate card HTML blocks
    const cardNames = {
      round: 'Round Shot', chain: 'Chain Shot', grape: 'Grapeshot', mortar: 'Mortar',
      firebomb: 'Firebomb', bore: 'Bore Shot', patch: 'Patch Kit', twin: 'Twin Shot',
      broadside: 'Triple Shot', keg: 'Powder Keg'
    };
    
    let cardsHtml = '';
    for (const id of CARD_IDS) {
      cardsHtml += `
        <div class="card-box">
          <h3>${cardNames[id]}</h3>
          <div class="form-group">
            <label>Direct Hit Damage</label>
            <input type="number" step="0.1" name="cards.${id}_damage" value="${data.cards[`${id}_damage`] || ''}" />
          </div>
          <div class="form-group">
            <label>Splash Damage (Epicenter)</label>
            <input type="number" step="0.1" name="cards.${id}_splashDamage" value="${data.cards[`${id}_splashDamage`] || ''}" />
          </div>
          ${id === 'patch' ? `
          <div class="form-group">
            <label>Heal Amount</label>
            <input type="number" step="0.1" name="cards.patch_heal" value="${data.cards.patch_heal || ''}" />
          </div>` : ''}
        </div>
      `;
    }

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Battle of Pirates Balance Editor</title>
        <style>
          :root {
            --bg: #0f172a;
            --text: #f8fafc;
            --card-bg: #1e293b;
            --border: #334155;
            --primary: #38bdf8;
            --secondary: #fbbf24;
            --input-bg: #0f172a;
            --btn-bg: #10b981;
            --btn-hover: #059669;
          }
          :root.light-mode {
            --bg: #f8fafc;
            --text: #0f172a;
            --card-bg: #ffffff;
            --border: #cbd5e1;
            --primary: #0284c7;
            --secondary: #d97706;
            --input-bg: #f1f5f9;
            --btn-bg: #10b981;
            --btn-hover: #059669;
          }
          
          body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); padding: 2rem; max-width: 900px; margin: 0 auto; transition: background 0.3s, color 0.3s; }
          .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
          h1 { color: var(--primary); margin: 0; }
          
          .theme-toggle { background: var(--card-bg); color: var(--text); border: 1px solid var(--border); padding: 0.5rem 1rem; border-radius: 0.5rem; cursor: pointer; }
          
          .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
          .card-box { background: var(--card-bg); padding: 1.5rem; border-radius: 0.75rem; border: 1px solid var(--border); transition: background 0.3s; }
          .card-box h3 { margin-top: 0; color: var(--secondary); border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
          .form-group { margin-bottom: 1rem; display: flex; align-items: center; justify-content: space-between; }
          label { font-weight: 600; font-size: 0.9rem; }
          input { background: var(--input-bg); border: 1px solid var(--border); color: var(--text); padding: 0.5rem; border-radius: 0.25rem; width: 80px; text-align: right; transition: background 0.3s; }
          
          .section-title { font-size: 1.5rem; color: var(--primary); margin: 2rem 0 1rem; border-bottom: 2px solid var(--border); padding-bottom: 0.5rem; }
          
          .btn-container { text-align: center; position: sticky; bottom: 1rem; margin-top: 2rem; }
          button.save-btn { background: var(--btn-bg); color: white; border: none; padding: 1rem 3rem; font-size: 1.2rem; font-weight: bold; border-radius: 0.5rem; cursor: pointer; transition: background 0.2s; box-shadow: 0 4px 15px rgba(0,0,0,0.3); }
          button.save-btn:hover { background: var(--btn-hover); }
          .toast { position: fixed; top: 1rem; right: 1rem; background: var(--btn-bg); color: white; padding: 1rem 2rem; border-radius: 0.5rem; display: none; font-weight: bold; z-index: 100; box-shadow: 0 4px 6px rgba(0,0,0,0.2); }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>⚖️ Ultimate Balance Editor</h1>
          <button class="theme-toggle" id="themeToggle">🌓 Toggle Light/Dark</button>
        </div>
        
        <div class="toast" id="toast">✅ Saved Successfully!</div>
        
        <form id="balanceForm">
          <div class="section-title">Weapons (Cards)</div>
          <p style="font-size: 0.9rem; margin-top:-0.5rem;">Note: For multi-shot weapons (Twin, Triple, Grape, Chain), damage applies PER BALL.</p>
          <div class="grid">
            ${cardsHtml}
          </div>

          <div class="section-title">Special Abilities</div>
          <div class="grid">
            <div class="card-box">
              <h3>Specials Meter</h3>
              <div class="form-group">
                <label>Torpedo Damage</label>
                <input type="number" name="specials.torpedo" value="${data.specials.torpedo}" />
              </div>
              <div class="form-group">
                <label>Acid Rain Damage</label>
                <input type="number" name="specials.acidRain" value="${data.specials.acidRain}" />
              </div>
              <div class="form-group">
                <label>Heal Amount</label>
                <input type="number" name="specials.heal" value="${data.specials.heal}" />
              </div>
            </div>
          </div>

          <div class="btn-container">
            <button type="submit" class="save-btn">💾 Save & Update Code</button>
          </div>
        </form>

        <script>
          // Theme toggling
          const html = document.documentElement;
          const themeToggle = document.getElementById('themeToggle');
          if (localStorage.getItem('theme') === 'light') html.classList.add('light-mode');
          
          themeToggle.addEventListener('click', () => {
            html.classList.toggle('light-mode');
            localStorage.setItem('theme', html.classList.contains('light-mode') ? 'light' : 'dark');
          });

          // Form submission
          document.getElementById('balanceForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            const data = { cards: {}, specials: {} };
            
            for (let [key, value] of formData.entries()) {
              if (!value) continue;
              if (key.startsWith('cards.')) {
                data.cards[key.split('.')[1]] = Number(value);
              } else if (key.startsWith('specials.')) {
                data.specials[key.split('.')[1]] = Number(value);
              } else {
                data[key] = Number(value);
              }
            }

            try {
              const res = await fetch('/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
              });
              
              if (res.ok) {
                const toast = document.getElementById('toast');
                toast.style.display = 'block';
                setTimeout(() => toast.style.display = 'none', 3000);
              } else {
                alert('Server returned error');
              }
            } catch (err) {
              alert('Error saving: ' + err.message);
            }
          });
        </script>
      </body>
      </html>
    `;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } else if (req.method === 'POST' && req.url === '/update') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        updateRules(data);
        res.writeHead(200);
        res.end('OK');
      } catch (err) {
        res.writeHead(500);
        res.end(err.message);
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(4000, () => {
  console.log('Balance Editor running at http://localhost:4000');
});
