// The standard screen's own words, in both languages (the plugin's i18n is not needed). `{name}` is the plugin's name.
const WORDS = {
  watch: ["Ver", "Watch"],
  info: ["Más información", "More info"],
  recent: ["Continuar viendo", "Continue watching"],
  search: ["Buscar", "Search"],
  searchHint: ["Buscar en {name}", "Search {name}"],
  failed: ["No se pudo cargar esta sección. Revisa tu conexión e inténtalo de nuevo.", "This section could not be loaded. Check your connection and try again."],
  retry: ["Reintentar", "Retry"],
  empty: ["Aún no hay nada aquí.", "Nothing here yet."],
  back: ["Atrás", "Back"],
  close: ["Cerrar", "Close"],
  settings: ["Ajustes", "Settings"],
  supportTv: ["Si te gusta mi trabajo, escanéalo y apóyame", "If you like my work, scan it and support me"],
  support: ["Si te gusta mi trabajo, apóyame", "If you like my work, support me"],
  gateTitle: ["Necesitas el motor de reproducción", "You need the playback engine"],
  gateText: ["{name} reproduce a través de Kino Resolver (gratis). Instálalo una vez y sirve para este y para otros plugins de sitios.",
    "{name} plays through Kino Resolver (free). Install it once and it works here and in other site plugins."],
  gateInstall: ["Instalar Kino Resolver", "Install Kino Resolver"],
};

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));

/** `key` as a node's twin fields: `{ [field]: Spanish, [field + "En"]: English }`. `vars` values may be `[es, en]`. */
export function twin(key, field = "text", vars) {
  const [es, en] = WORDS[key];
  const pick = (i) => vars && Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, Array.isArray(v) ? v[i] : v]));
  return { [field]: fill(es, pick(0)), [field + "En"]: fill(en, pick(1)) };
}

export const STRING_KEYS = Object.keys(WORDS);
