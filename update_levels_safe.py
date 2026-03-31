import json
import os

# Paths
json_path = r"c:\Users\hp\Downloads\campaign_sectors_backup (1).json"
ts_path = r"d:\PlayBuddies-main\PlayBuddies-main\public\games\games\fireboy-watergirl\src\game\levels.ts"

with open(json_path, 'r', encoding='utf-8') as f:
    levels_data = json.load(f)

# Ensure continuity and clean data
for i, level in enumerate(levels_data):
    level['id'] = i + 1

levels_json = json.dumps(levels_data, indent=2)

ts_content = f"""// Bilal Saeed 1230
import {{ Level }} from '../types';

export const DEFAULT_LEVELS: Level[] = {levels_json};

export function getLevels(): Level[] {{
  const overrides = JSON.parse(localStorage.getItem('main_level_overrides') || '{{}}');
  return DEFAULT_LEVELS.map(level => overrides[level.id] || level);
}}
// Bilal Saeed 1230
"""

with open(ts_path, 'w', encoding='utf-8') as f:
    f.write(ts_content)

print("Successfully updated levels.ts")
