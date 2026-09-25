/**
 * Injected by WalletView.qml after page load. Provides the
 * `window.logos.callModuleAsync` contract the wallet-ui ModuleBackend
 * expects, queuing calls into an outbox the QML drain pump collects.
 *
 * Responses arrive as window.postMessage({type:"logos_response",
 * requestId, result|error}) from the QML side.
 */
(function () {
  if (window.__logosBridge) return;

  var outbox = [];
  var pending = {};
  var seq = 0;

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.type !== 'logos_response') return;
    var slot = pending[d.requestId];
    if (!slot) return;
    delete pending[d.requestId];
    if (d.error !== undefined && d.error !== null) slot.reject(new Error(String(d.error)));
    else slot.resolve(d.result);
  });

  window.__logosBridge = {
    drain: function () {
      var q = outbox;
      outbox = [];
      return q;
    },
  };

  window._qtDrain = window.__logosBridge.drain;

  window.logos = window.logos || {};
  window.logos.callModuleAsync = function (module, method, args, cb) {
    var requestId = ++seq;
    var promise = new Promise(function (resolve, reject) {
      pending[requestId] = { resolve: resolve, reject: reject };
    });
    outbox.push({ requestId: requestId, module: module, method: method, args: args || [] });
    if (typeof cb === 'function') {
      promise.then(function (r) {
        cb(typeof r === 'string' ? r : JSON.stringify(r));
      });
    }
  };
})();
