import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RULES_PATH = path.join(ROOT, 'games', 'battle-of-pirates', 'src', 'game', 'rules.ts');
const SPECIALS_PATH = path.join(ROOT, 'games', 'battle-of-pirates', 'src', 'game', 'specials.ts');
const HULLS_PATH = path.join(ROOT, 'games', 'battle-of-pirates', 'src', 'game', 'hulls.ts');

const CARD_IDS = ['round', 'chain', 'grape', 'mortar', 'firebomb', 'bore', 'patch', 'twin', 'broadside', 'keg'];
const CARD_KEYS = ['weight', 'spread', 'damage', 'splashDamage', 'blast', 'gravity', 'speed'];

function parseRules() {
  const content = fs.readFileSync(RULES_PATH, 'utf-8');
  const specialsContent = fs.readFileSync(SPECIALS_PATH, 'utf-8');
  const hullsContent = fs.readFileSync(HULLS_PATH, 'utf-8');
  
  const cards = {};
  const getCardVal = (cardId, key) => {
    const blockRegex = new RegExp(`${cardId}:\\s*\\{[^}]*?\\}`, 's');
    const blockMatch = content.match(blockRegex);
    if (blockMatch) {
      const valMatch = blockMatch[0].match(new RegExp(`\\b${key}:\\s*([\\d.]+)`));
      return valMatch ? valMatch[1] : null;
    }
    return null;
  };
  
  for (const id of CARD_IDS) {
    for (const key of CARD_KEYS) {
      cards[`${id}_${key}`] = getCardVal(id, key);
    }
    if (id === 'patch') {
      cards[`${id}_heal`] = getCardVal(id, 'heal');
    }
    if (id === 'firebomb') {
      cards[`${id}_burn`] = getCardVal(id, 'burn');
    }
  }
  
  const specials = {
    torpedo: specialsContent.match(/torpedo:\s*\{[^}]*amount:\s*([\d.]+)/)?.[1] || 25,
    acidRain: specialsContent.match(/acid-rain':\s*\{[^}]*amount:\s*([\d.]+)/)?.[1] || 15,
    heal: specialsContent.match(/heal:\s*\{[^}]*amount:\s*([\d.]+)/)?.[1] || 20
  };

  let hulls = [];
  const hullsMatch = hullsContent.match(/export const HULLS: HullClass\[\] = (\[[\s\S]*?\n\];)/);
  if (hullsMatch) {
    try {
      const clean = hullsMatch[1].replace(/;\s*$/, '');
      hulls = eval('(' + clean + ')');
    } catch (e) {
      console.error('Error parsing HULLS from hulls.ts:', e);
    }
  }

  return { cards, specials, hulls };
}

function formatHullsCode(hulls) {
  const items = hulls.map((h, i) => {
    const id = (h.id || `hull_${i}`).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const name = String(h.name || `Hull ${i + 1}`).trim();
    const blurb = String(h.blurb || '').trim();
    const cost = String(h.cost || '').trim();
    const perks = Array.isArray(h.perks)
      ? h.perks.map(p => String(p).trim()).filter(Boolean)
      : typeof h.perks === 'string'
        ? h.perks.split(',').map(p => p.trim()).filter(Boolean)
        : [];

    const hp = Number(h.hp) || 1;
    const width = Number(h.width) || 1;
    const drift = Number(h.drift) || 1;
    const blast = Number(h.blast) || 1;
    const damage = Number(h.damage) || 1;
    const critChance = Number(h.critChance) || 0;
    const critDamage = Number(h.critDamage) || 1;
    const aimDots = Math.round(Number(h.aimDots) || 0);

    const extraProps = [];
    if (h.hpDots !== undefined && h.hpDots !== null && h.hpDots !== '' && Number(h.hpDots) > 0) {
      extraProps.push(`hpDots: ${Math.round(Number(h.hpDots))}`);
    }
    if (h.damageDots !== undefined && h.damageDots !== null && h.damageDots !== '' && Number(h.damageDots) > 0) {
      extraProps.push(`damageDots: ${Math.round(Number(h.damageDots))}`);
    }
    if (h.critDots !== undefined && h.critDots !== null && h.critDots !== '' && Number(h.critDots) > 0) {
      extraProps.push(`critDots: ${Math.round(Number(h.critDots))}`);
    }
    if (h.aimGuideDots !== undefined && h.aimGuideDots !== null && h.aimGuideDots !== '' && Number(h.aimGuideDots) > 0) {
      extraProps.push(`aimGuideDots: ${Math.round(Number(h.aimGuideDots))}`);
    }
    const extraStr = extraProps.length > 0 ? `,\n    ${extraProps.join(', ')}` : '';

    return `  {
    id: ${JSON.stringify(id)},
    name: ${JSON.stringify(name)},
    blurb: ${JSON.stringify(blurb)},
    cost: ${JSON.stringify(cost)},
    perks: ${JSON.stringify(perks)},
    hp: ${hp}, width: ${width}, drift: ${drift}, blast: ${blast}, damage: ${damage},
    critChance: ${critChance}, critDamage: ${critDamage}, aimDots: ${aimDots}${extraStr},
  },`;
  }).join('\n');

  return `export const HULLS: HullClass[] = [\n${items}\n];`;
}

function updateRules(data) {
  let content = fs.readFileSync(RULES_PATH, 'utf-8');
  let specialsContent = fs.readFileSync(SPECIALS_PATH, 'utf-8');

  const setCardVal = (cardId, key, val) => {
    if (val === undefined || val === null || val === '') return;
    const blockRegex = new RegExp(`(${cardId}:\\s*\\{[^}]*?\\b)(${key}:\\s*)([\\d.]+)`, 's');
    content = content.replace(blockRegex, `$1$2${val}`);
  };

  if (data.cards) {
    for (const id of CARD_IDS) {
      for (const key of CARD_KEYS) {
        setCardVal(id, key, data.cards[`${id}_${key}`]);
      }
      setCardVal('patch', 'heal', data.cards['patch_heal']);
      setCardVal('firebomb', 'burn', data.cards['firebomb_burn']);
    }

    // Synchronize card blurbs so in-game UI descriptions match configured values
    const updateCardBlurb = (cardId, pattern, replacement) => {
      const blockRegex = new RegExp(`(${cardId}:\\s*\\{[^}]*?blurb:\\s*')(.*?)(')`, 's');
      content = content.replace(blockRegex, (match, prefix, oldBlurb, suffix) => {
        const newBlurb = oldBlurb.replace(pattern, replacement);
        return `${prefix}${newBlurb}${suffix}`;
      });
    };

    if (data.cards['chain_damage'] !== undefined) {
      updateCardBlurb('chain', /Two linked \d+-damage balls/, `Two linked ${data.cards['chain_damage']}-damage balls`);
    }
    if (data.cards['twin_damage'] !== undefined) {
      updateCardBlurb('twin', /Two \d+-damage cannonballs/, `Two ${data.cards['twin_damage']}-damage cannonballs`);
    }
    if (data.cards['broadside_damage'] !== undefined) {
      updateCardBlurb('broadside', /Three \d+-damage cannonballs/, `Three ${data.cards['broadside_damage']}-damage cannonballs`);
    }
    if (data.cards['patch_heal'] !== undefined) {
      updateCardBlurb('patch', /Heals \d+/, `Heals ${data.cards['patch_heal']}`);
    }
    if (data.cards['firebomb_burn'] !== undefined) {
      const burnVal = data.cards['firebomb_burn'];
      const word = burnVal === 1 ? 'one' : burnVal === 2 ? 'two' : burnVal === 3 ? 'three' : burnVal === 4 ? 'four' : `${burnVal}`;
      updateCardBlurb('firebomb', /Burns for \w+ of their turns/, `Burns for ${word} of their turns`);
    }
  }

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

  if (Array.isArray(data.hulls) && data.hulls.length > 0) {
    let hullsContent = fs.readFileSync(HULLS_PATH, 'utf-8');
    hullsContent = hullsContent.replace(
      /export const HULLS: HullClass\[\] = \[[\s\S]*?\n\];/,
      formatHullsCode(data.hulls)
    );
    fs.writeFileSync(HULLS_PATH, hullsContent, 'utf-8');
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    const data = parseRules();

    const cardNames = {
      round: 'Round Shot', chain: 'Chain Shot', grape: 'Grapeshot', mortar: 'Mortar',
      firebomb: 'Firebomb', bore: 'Bore Shot', patch: 'Patch Kit', twin: 'Twin Shot',
      broadside: 'Triple Shot', keg: 'Powder Keg'
    };

    const LABELS = {
      weight: 'Spawn Weight (Chance)',
      spread: 'Spread (Radians)',
      damage: 'Direct Hit Damage',
      splashDamage: 'Splash Dmg (Epicenter)',
      blast: 'Blast Radius Multiplier',
      gravity: 'Gravity Multiplier',
      speed: 'Speed Multiplier'
    };
    
    let cardsHtml = '';
    for (const id of CARD_IDS) {
      cardsHtml += `
        <div class="card-box">
          <h3>${cardNames[id]}</h3>
          <div class="props-grid">
            ${CARD_KEYS.map(key => `
              <div class="form-group">
                <label>${LABELS[key]}</label>
                <input type="number" step="0.01" name="cards.${id}_${key}" value="${data.cards[`${id}_${key}`] ?? ''}" />
              </div>
            `).join('')}
            ${id === 'patch' ? `
              <div class="form-group">
                <label>Heal Amount</label>
                <input type="number" step="0.1" name="cards.patch_heal" value="${data.cards.patch_heal ?? ''}" />
              </div>` : ''}
            ${id === 'firebomb' ? `
              <div class="form-group">
                <label>Burn Duration (Turns)</label>
                <input type="number" step="1" name="cards.firebomb_burn" value="${data.cards.firebomb_burn ?? ''}" />
              </div>` : ''}
          </div>
        </div>
      `;
    }

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Battle of Pirates Balance Editor</title>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
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
            --danger-bg: #ef4444;
            --danger-hover: #dc2626;
            --accent: #a855f7;
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
            --danger-bg: #ef4444;
            --danger-hover: #dc2626;
            --accent: #9333ea;
          }

          body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); padding: 2rem; max-width: 1200px; margin: 0 auto; transition: background 0.3s, color 0.3s; }
          .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
          h1 { color: var(--primary); margin: 0; font-size: 1.8rem; }

          .theme-toggle { background: var(--card-bg); color: var(--text); border: 1px solid var(--border); padding: 0.5rem 1rem; border-radius: 0.5rem; cursor: pointer; }
          
          .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
          .card-box { background: var(--card-bg); padding: 1.5rem; border-radius: 0.75rem; border: 1px solid var(--border); transition: background 0.3s; position: relative; }
          .card-box h3 { margin-top: 0; color: var(--secondary); border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; margin-bottom: 1rem; display: flex; justify-content: space-between; align-items: center; }

          .props-grid { display: grid; grid-template-columns: 1fr; gap: 0.5rem; }
          .form-group { display: flex; align-items: center; justify-content: space-between; font-size: 0.85rem; }
          .form-group.full { flex-direction: column; align-items: stretch; gap: 0.25rem; }
          .form-group.full input, .form-group.full textarea { width: 100%; text-align: left; box-sizing: border-box; }
          label { font-weight: 600; color: var(--text); opacity: 0.9; }
          input, textarea { background: var(--input-bg); border: 1px solid var(--border); color: var(--text); padding: 0.35rem 0.5rem; border-radius: 0.25rem; width: 75px; text-align: right; transition: background 0.3s; }
          input:focus, textarea:focus { outline: none; border-color: var(--primary); }
          
          .section-header { display: flex; justify-content: space-between; align-items: center; margin: 2.5rem 0 1rem; border-bottom: 2px solid var(--border); padding-bottom: 0.5rem; }
          .section-title { font-size: 1.5rem; color: var(--primary); margin: 0; }
          .section-desc { font-size: 0.9rem; margin-top: -0.5rem; margin-bottom: 1.25rem; opacity: 0.8; }
          
          .btn-container { text-align: center; position: sticky; bottom: 1rem; margin-top: 2rem; z-index: 50; }
          button.save-btn { background: var(--btn-bg); color: white; border: none; padding: 1rem 3rem; font-size: 1.2rem; font-weight: bold; border-radius: 0.5rem; cursor: pointer; transition: background 0.2s, transform 0.1s; box-shadow: 0 4px 15px rgba(0,0,0,0.3); }
          button.save-btn:hover { background: var(--btn-hover); transform: translateY(-1px); }

          button.add-btn { background: var(--accent); color: white; border: none; padding: 0.5rem 1.25rem; font-size: 0.95rem; font-weight: bold; border-radius: 0.5rem; cursor: pointer; transition: opacity 0.2s; }
          button.add-btn:hover { opacity: 0.9; }

          button.del-btn { background: var(--danger-bg); color: white; border: none; padding: 0.25rem 0.6rem; font-size: 0.75rem; font-weight: bold; border-radius: 0.35rem; cursor: pointer; }
          button.del-btn:hover { background: var(--danger-hover); }

          .id-tag { font-size: 0.75rem; background: rgba(56, 189, 248, 0.15); color: var(--primary); padding: 0.15rem 0.45rem; border-radius: 0.25rem; font-family: monospace; }
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
          <div class="section-header">
            <h2 class="section-title">🚢 Ship Hulls & Roles</h2>
            <button type="button" class="add-btn" id="addHullBtn">+ Add New Hull</button>
          </div>
          <p class="section-desc">Tune health, damage, silhouette size, drift, and perks for each battle role, or add new playable hull classes.</p>
          <div class="grid" id="hullsGrid"></div>

          <div class="section-header">
            <h2 class="section-title">⚔️ Weapons (Cards)</h2>
          </div>
          <p class="section-desc">For multi-shot weapons (Twin, Triple, Grape, Chain), damage applies PER CANNONBALL.</p>
          <div class="grid">
            ${cardsHtml}
          </div>

          <div class="section-header">
            <h2 class="section-title">⚡ Special Abilities</h2>
          </div>
          <p class="section-desc">Meter charge is earned once per damaging attack.</p>
          <div class="grid">
            <div class="card-box">
              <h3>Specials Meter</h3>
              <div class="props-grid">
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
          </div>

          <div class="btn-container">
            <button type="submit" class="save-btn">💾 Save & Update Code</button>
          </div>
        </form>

        <script>
          const initialHulls = ${JSON.stringify(data.hulls)};
          const hullsGrid = document.getElementById('hullsGrid');

          function renderHullCard(hull, index) {
            const card = document.createElement('div');
            card.className = 'card-box hull-card';
            card.dataset.index = index;

            const perksText = Array.isArray(hull.perks) ? hull.perks.join(', ') : (hull.perks || '');

            card.innerHTML = \`
              <h3>
                <span class="hull-title">\${hull.name || 'New Hull'}</span>
                <div>
                  <span class="id-tag">\${hull.id || 'custom'}</span>
                  <button type="button" class="del-btn" title="Remove hull class" onclick="deleteHull(this)">✕</button>
                </div>
              </h3>
              <div class="props-grid">
                <div class="form-group full">
                  <label>Role Name</label>
                  <input type="text" class="h-name" value="\${hull.name || ''}" placeholder="e.g. Corsair" oninput="updateHullTitle(this)" />
                </div>
                <div class="form-group full">
                  <label>Unique ID (lowercase, a-z0-9_)</label>
                  <input type="text" class="h-id" value="\${hull.id || ''}" placeholder="e.g. corsair" oninput="updateHullId(this)" />
                </div>
                <div class="form-group full">
                  <label>Lobby Blurb / Description</label>
                  <input type="text" class="h-blurb" value="\${hull.blurb || ''}" placeholder="Role description in lobby" />
                </div>
                <div class="form-group full">
                  <label>Cost / Trade-off</label>
                  <input type="text" class="h-cost" value="\${hull.cost || ''}" placeholder="e.g. Less armour, wide target" />
                </div>
                <div class="form-group full">
                  <label>Perks (comma-separated)</label>
                  <input type="text" class="h-perks" value="\${perksText}" placeholder="+20% damage, 90% hull" />
                </div>
                <div class="form-group">
                  <label>HP Multiplier (1.0 = 100 HP)</label>
                  <input type="number" step="0.01" class="h-hp" value="\${hull.hp ?? 1}" />
                </div>
                <div class="form-group">
                  <label>Cannon Damage Mult (1.0 = 100%)</label>
                  <input type="number" step="0.01" class="h-damage" value="\${hull.damage ?? 1}" />
                </div>
                <div class="form-group">
                  <label>Silhouette Width Mult (1.0 = 200px)</label>
                  <input type="number" step="0.01" class="h-width" value="\${hull.width ?? 1}" />
                </div>
                <div class="form-group">
                  <label>Speed / Drift Mult (1.0 = normal)</label>
                  <input type="number" step="0.01" class="h-drift" value="\${hull.drift ?? 1}" />
                </div>
                <div class="form-group">
                  <label>Blast Radius Mult (1.0 = standard)</label>
                  <input type="number" step="0.01" class="h-blast" value="\${hull.blast ?? 1}" />
                </div>
                <div class="form-group">
                  <label>Critical Chance (0.0 to 1.0)</label>
                  <input type="number" step="0.01" class="h-critChance" value="\${hull.critChance ?? 0}" />
                </div>
                <div class="form-group">
                  <label>Critical Damage Mult (e.g. 1.7x)</label>
                  <input type="number" step="0.05" class="h-critDamage" value="\${hull.critDamage ?? 1}" />
                </div>
                <div class="form-group">
                  <label>Aim Guide Extra Dots (0 - 8)</label>
                  <input type="number" step="1" class="h-aimDots" value="\${hull.aimDots ?? 0}" />
                </div>
                <div class="form-group full" style="border-top: 1px dashed rgba(255,255,255,0.12); padding-top: 10px; margin-top: 6px;">
                  <label style="color: #ffd27d; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;">
                    Visual Meter Dots (1 - 5, leave blank for Auto-adjust)
                  </label>
                </div>
                <div class="form-group">
                  <label>Hull Dots (1-5, blank=Auto)</label>
                  <input type="number" min="1" max="5" class="h-hpDots" value="\${hull.hpDots ?? ''}" placeholder="Auto" />
                </div>
                <div class="form-group">
                  <label>Guns Dots (1-5, blank=Auto)</label>
                  <input type="number" min="1" max="5" class="h-damageDots" value="\${hull.damageDots ?? ''}" placeholder="Auto" />
                </div>
                <div class="form-group">
                  <label>Critical Dots (1-5, blank=Auto)</label>
                  <input type="number" min="1" max="5" class="h-critDots" value="\${hull.critDots ?? ''}" placeholder="Auto" />
                </div>
                <div class="form-group">
                  <label>Aim Dots (1-5, blank=Auto)</label>
                  <input type="number" min="1" max="5" class="h-aimGuideDots" value="\${hull.aimGuideDots ?? ''}" placeholder="Auto" />
                </div>
              </div>
            \`;
            return card;
          }

          function updateHullTitle(input) {
            const card = input.closest('.hull-card');
            const titleSpan = card.querySelector('.hull-title');
            titleSpan.textContent = input.value.trim() || 'Unnamed Hull';
          }

          function updateHullId(input) {
            const card = input.closest('.hull-card');
            const tag = card.querySelector('.id-tag');
            tag.textContent = input.value.trim().toLowerCase() || 'custom';
          }

          function deleteHull(btn) {
            const cards = document.querySelectorAll('.hull-card');
            if (cards.length <= 1) {
              alert('You must keep at least one hull class!');
              return;
            }
            if (confirm('Are you sure you want to delete this hull class?')) {
              btn.closest('.hull-card').remove();
            }
          }

          initialHulls.forEach((hull, i) => {
            hullsGrid.appendChild(renderHullCard(hull, i));
          });

          document.getElementById('addHullBtn').addEventListener('click', () => {
            const newIndex = document.querySelectorAll('.hull-card').length;
            const newHull = {
              id: 'custom_' + Date.now().toString().slice(-4),
              name: 'New Hull ' + (newIndex + 1),
              blurb: 'A versatile battle role ready for custom tactical tuning.',
              cost: 'Balanced trade-off',
              perks: ['Even strength', 'Specialized handling'],
              hp: 1.0,
              width: 1.0,
              drift: 1.0,
              blast: 1.0,
              damage: 1.0,
              critChance: 0.1,
              critDamage: 1.5,
              aimDots: 1
            };
            const card = renderHullCard(newHull, newIndex);
            hullsGrid.appendChild(card);
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          });

          const html = document.documentElement;
          const themeToggle = document.getElementById('themeToggle');
          if (localStorage.getItem('theme') === 'light') html.classList.add('light-mode');
          
          themeToggle.addEventListener('click', () => {
            html.classList.toggle('light-mode');
            localStorage.setItem('theme', html.classList.contains('light-mode') ? 'light' : 'dark');
          });

          document.getElementById('balanceForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            const data = { cards: {}, specials: {}, hulls: [] };
            
            for (let [key, value] of formData.entries()) {
              if (value === '') continue;
              if (key.startsWith('cards.')) {
                data.cards[key.split('.')[1]] = Number(value);
              } else if (key.startsWith('specials.')) {
                data.specials[key.split('.')[1]] = Number(value);
              }
            }

            document.querySelectorAll('.hull-card').forEach((card, idx) => {
              const id = card.querySelector('.h-id').value.trim() || ('hull_' + idx);
              const name = card.querySelector('.h-name').value.trim() || ('Hull ' + (idx + 1));
              const blurb = card.querySelector('.h-blurb').value.trim();
              const cost = card.querySelector('.h-cost').value.trim();
              const perksRaw = card.querySelector('.h-perks').value;
              const perks = perksRaw.split(',').map(p => p.trim()).filter(Boolean);

              const hpDotsVal = card.querySelector('.h-hpDots')?.value.trim();
              const damageDotsVal = card.querySelector('.h-damageDots')?.value.trim();
              const critDotsVal = card.querySelector('.h-critDots')?.value.trim();
              const aimGuideDotsVal = card.querySelector('.h-aimGuideDots')?.value.trim();

              const hullObj = {
                id,
                name,
                blurb,
                cost,
                perks,
                hp: Number(card.querySelector('.h-hp').value) || 1,
                damage: Number(card.querySelector('.h-damage').value) || 1,
                width: Number(card.querySelector('.h-width').value) || 1,
                drift: Number(card.querySelector('.h-drift').value) || 1,
                blast: Number(card.querySelector('.h-blast').value) || 1,
                critChance: Number(card.querySelector('.h-critChance').value) || 0,
                critDamage: Number(card.querySelector('.h-critDamage').value) || 1,
                aimDots: Number(card.querySelector('.h-aimDots').value) || 0,
              };

              if (hpDotsVal !== '' && hpDotsVal !== undefined) hullObj.hpDots = Number(hpDotsVal);
              if (damageDotsVal !== '' && damageDotsVal !== undefined) hullObj.damageDots = Number(damageDotsVal);
              if (critDotsVal !== '' && critDotsVal !== undefined) hullObj.critDots = Number(critDotsVal);
              if (aimGuideDotsVal !== '' && aimGuideDotsVal !== undefined) hullObj.aimGuideDots = Number(aimGuideDotsVal);

              data.hulls.push(hullObj);
            });

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

let currentPort = Number(process.env.PORT) || 4000;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${currentPort} is in use, trying port ${currentPort + 1}...`);
    currentPort++;
    server.listen(currentPort, () => {
      console.log(`Balance Editor running at http://localhost:${currentPort}`);
    });
  } else {
    console.error('Server error:', err);
  }
});

server.listen(currentPort, () => {
  console.log(`Balance Editor running at http://localhost:${currentPort}`);
});

