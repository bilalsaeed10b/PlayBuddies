/** Stable order: codes 1–5 occupy bits 8–10; zero preserves old storm-only rooms. */
export const WEATHER = [
  { id: 'clear', name: 'Clear', hint: 'Sunlit water and clear skies.' },
  { id: 'rain', name: 'Rain', hint: 'Dark clouds, straight-down rain and gentle surface ripples.' },
  { id: 'thunder', name: 'Thunderstorm', hint: 'Heavy rain, distant lightning and rolling thunder.' },
  { id: 'mist', name: 'Sea mist', hint: 'Soft banks of fog along the horizon.' },
  { id: 'snow', name: 'Snowfall', hint: 'Cold blue water and slowly falling snow.' },
] as const;
export type WeatherKind = typeof WEATHER[number]['id'];
/** Random chooses a new cosmetic weather at the start of every full fleet round. */
export type WeatherChoice = WeatherKind | 'random';

export const WEATHER_CHOICES = [
  { id: 'random', name: 'Random each round', hint: 'A fresh sky rolls in after every full fleet cycle.' },
  ...WEATHER,
] as const;

export function weatherFor(rules: { storm: boolean; weather?: WeatherChoice }): WeatherKind {
  const selected = WEATHER.find((weather) => weather.id === rules.weather);
  return selected?.id ?? (rules.storm ? 'rain' : 'clear');
}

/**
 * A weather roll is derived from match data, never from wall time. That keeps
 * every spectator and reconnecting player looking at the same sea without a
 * weather packet in the turn protocol.
 */
export function weatherForRound(rules: { storm: boolean; weather?: WeatherChoice }, seed: number, round: number): WeatherKind {
  if (rules.weather !== 'random') return weatherFor(rules);
  // Randomize the opening sky from the match seed, then step through the
  // weather deck. This is still random from a player's perspective, while
  // guaranteeing that a new round never looks identical by coincidence.
  let n = seed >>> 0;
  n ^= n >>> 16; n = Math.imul(n, 0x85ebca6b) >>> 0; n ^= n >>> 13;
  return WEATHER[((n >>> 0) + round) % WEATHER.length].id;
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
