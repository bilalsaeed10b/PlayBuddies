/** Stable order: codes 1–5 occupy bits 8–10; zero preserves old storm-only rooms. */
export const WEATHER = [
  { id: 'clear', name: 'Clear', hint: 'Sunlit water and clear skies.' },
  { id: 'rain', name: 'Rain', hint: 'Dark clouds, straight-down rain and gentle surface ripples.' },
  { id: 'thunder', name: 'Thunderstorm', hint: 'Heavy rain, distant lightning and rolling thunder.' },
  { id: 'mist', name: 'Sea mist', hint: 'Soft banks of fog along the horizon.' },
  { id: 'snow', name: 'Snowfall', hint: 'Cold blue water and slowly falling snow.' },
] as const;
export type WeatherKind = typeof WEATHER[number]['id'];
/** Random chooses one cosmetic weather for the whole match. */
export type WeatherChoice = WeatherKind | 'random';

export const WEATHER_CHOICES = [
  { id: 'random', name: 'Random match weather', hint: 'One sky is chosen at launch and stays for the whole battle.' },
  ...WEATHER,
] as const;

export function weatherFor(rules: { storm: boolean; weather?: WeatherChoice }): WeatherKind {
  const selected = WEATHER.find((weather) => weather.id === rules.weather);
  return selected?.id ?? (rules.storm ? 'rain' : 'clear');
}

/**
 * The weather roll is derived once from the match seed, never from wall time
 * or turn number. Every peer therefore keeps the same sky for the full battle
 * without another field in the turn protocol.
 */
export function weatherForMatch(rules: { storm: boolean; weather?: WeatherChoice }, seed: number): WeatherKind {
  if (rules.weather !== 'random') return weatherFor(rules);
  let n = seed >>> 0;
  n ^= n >>> 16; n = Math.imul(n, 0x85ebca6b) >>> 0; n ^= n >>> 13;
  return WEATHER[(n >>> 0) % WEATHER.length].id;
}
export const wetWeather = (kind: WeatherChoice) => kind === 'rain' || kind === 'thunder';

/** Distant lightning once every 14 seconds; sound arrives a little later. */
export const THUNDER_PERIOD = 14;
export const THUNDER_FLASH = 4;
export const THUNDER_SOUND = 4.8;
export function thunderEnvelope(clock: number): number {
  const age = clock % THUNDER_PERIOD - THUNDER_FLASH;
  return age >= 0 && age < 0.65 ? Math.sin(age / 0.65 * Math.PI) ** 2 : 0;
}
