import json

# Paths
json_path = r"c:\Users\hp\Downloads\campaign_sectors_backup (1).json"
ts_path = r"d:\PlayBuddies-main\PlayBuddies-main\public\games\games\fireboy-watergirl\src\game\levels.ts"

with open(json_path, 'r', encoding='utf-8') as f:
    levels_data = f.read()

ts_code = f"""import {{ Level }} from '../types';

export const DEFAULT_LEVELS: Level[] = {levels_data};

export function getLevels(): Level[] {{
  const overrides = JSON.parse(localStorage.getItem('main_level_overrides') || '{{}}');
  return DEFAULT_LEVELS.map(level => overrides[level.id] || level);
}}
"""

with open(ts_path, 'w', encoding='utf-8') as f:
    f.write(ts_code)

print("Successfully replaced DEFAULT_LEVELS with your exported levels.")
