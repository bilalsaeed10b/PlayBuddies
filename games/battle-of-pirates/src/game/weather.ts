/** Stable order: codes occupy bits 8–10; zero preserves old storm-only rooms. */
export const WEATHER = [
  { id: 'clear', name: 'Clear', hint: 'Sunlit water and clear skies.' },
  { id: 'rain', name: 'Rain', hint: 'Dark clouds, straight-down rain and gentle surface ripples.' },
  { id: 'thunder', name: 'Thunderstorm', hint: 'Heavy rain, distant lightning and rolling thunder.' },
  { id: 'mist', name: 'Sea mist', hint: 'Soft banks of fog along the horizon.' },
  { id: 'snow', name: 'Snowfall', hint: 'Cold blue water and slowly falling snow.' },
] as const;
export type WeatherKind = typeof WEATHER[number]['id'];

export function weatherFor(rules: { storm: boolean; weather?: WeatherKind }): WeatherKind {
  return WEATHER.some(w => w.id === rules.weather) ? rules.weather! : rules.storm ? 'rain' : 'clear';
}
export const wetWeather = (kind: WeatherKind) => kind === 'rain' || kind === 'thunder';

/** Distant lightning once every 14 seconds; sound arrives a little later. */
export const THUNDER_PERIOD = 14;
export const THUNDER_FLASH = 4;
export const THUNDER_SOUND = 4.8;
export function thunderEnvelope(clock: number): number {
  const age = clock % THUNDER_PERIOD - THUNDER_FLASH;
  return age >= 0 && age < 0.65 ? Math.sin(age / 0.65 * Math.PI) ** 2 : 0;
}
