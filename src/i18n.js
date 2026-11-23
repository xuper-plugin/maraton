// Every text the person reads, in Spanish and English: Kino does not translate a plugin's texts.
const T = {
  brWatch: ["Ver ahora", "Watch now"],
  brInfo: ["Más información", "More info"],
  brRecent: ["Continuar viendo", "Continue watching"],
  brEmpty: ["No hay títulos para mostrar ahora.", "There is nothing to show right now."],
  brFailed: ["No se pudo cargar esta sección. Revisa tu conexión.", "This section could not be loaded. Check your connection."],
  brRetry: ["Reintentar", "Retry"],
  brClose: ["Cerrar", "Close"],
  brBack: ["Atrás", "Back"],
  brSearch: ["Buscar", "Search"],
  brSettings: ["Ajustes", "Settings"],
  brSearchHint: ["Escribe un título", "Type a title"],
  brSearchTitle: ["Buscar", "Search"],
  brSearchFailed: ["La búsqueda no respondió. Intenta de nuevo.", "The search did not answer. Try again."],
  brNoResults: ["No encontramos nada con esas palabras.", "Nothing matched those words."],
  brSearchedBefore: ["Buscados antes", "Searched before"],
  noServer: ["Esta película no tiene ahora un servidor que abra. Intenta de nuevo más tarde.", "This movie has no server that opens right now. Try again later."],
  siteDown: ["El catálogo no responde ahora. Intenta de nuevo en un rato.", "The catalog is not answering right now. Try again in a moment."],
};

/** `key` in both languages: `{ es, en }`, with `{name}` placeholders filled from [vars]. */
export function both(key, vars = {}) {
  const pair = T[key] || [key, key];
  const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : ""));
  return { es: fill(pair[0]), en: fill(pair[1]) };
}

/** `key` in the person's language (anything that is not Spanish reads English). */
export function t(kino, key, vars) {
  const w = both(key, vars);
  return String((kino && kino.lang) || "").toLowerCase().startsWith("es") ? w.es : w.en;
}
