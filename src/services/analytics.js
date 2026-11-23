// ---- Analytics (Microsoft Clarity) ----
// Only loaded from production builds served on a real host, never in local dev or `vite preview`.
// `VITE_ANALYTICS=off` at build time leaves it out entirely (e.g. the temporary GitHub Pages build).

export function initAnalytics() {
  const IS_LOCALHOST = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  if (import.meta.env.PROD && import.meta.env.VITE_ANALYTICS !== "off" && !IS_LOCALHOST) {
    (function(c,l,a,r,i,t,y){
      c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
      t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
      y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
    })(window, document, "clarity", "script", "xzz1v75lj8");
  }
}

export function trackClarityEvent(eventName) {
  if (typeof window !== "undefined" && typeof window.clarity === "function") {
    window.clarity("event", eventName);
  }
}
