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

# We use double curly braces {{ }} to escape them in f-strings for Python
# Since we are writing TS code, we want {{ }} to appear in the output as { }
ts_content = f"""// Bilal Saeed 1230
import {{ Level }} from '../types';

export const DEFAULT_LEVELS: Level[] = {levels_json};

export function getLevels(): Level[] {{
  // Bilal Saeed 1230 - Bypass overrides to ensure new levels load
  return DEFAULT_LEVELS;
}}
// Bilal Saeed 1230
"""

with open(ts_path, 'w', encoding='utf-8') as f:
    f.write(ts_content)

print("Successfully updated levels.ts and bypassed overrides.")
