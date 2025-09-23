(function initStreamingLoader() {
  const pending = {};
  const bases = {
    hls: { url: '/assets/libs/hls.min.js', global: 'Hls' },
    dash: { url: '/assets/libs/dash.all.min.js', global: 'dashjs' },
  };

  function getGlobal(globalName) {
    const parts = globalName.split('.');
    let ref = window;
    for (const part of parts) {
      if (!ref) return undefined;
      ref = ref[part];
    }
    return ref;
  }

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = (event) => {
        script.remove();
        reject(new Error(`Failed to load script ${url}`));
      };
      document.head.appendChild(script);
    });
  }

  async function ensureLoaded(kind) {
    const meta = bases[kind];
    if (!meta) throw new Error(`Unknown streaming library ${kind}`);

    const existing = getGlobal(meta.global);
    if (existing) return existing;

    if (!pending[kind]) {
      pending[kind] = loadScript(meta.url)
        .then(() => {
          const lib = getGlobal(meta.global);
          if (!lib) throw new Error(`Library ${meta.global} unavailable after load`);
          return lib;
        })
        .catch((err) => {
          delete pending[kind];
          throw err;
        });
    }

    return pending[kind];
  }

  window.__oaVideoLoadStreamingLib = ensureLoaded;
})();
