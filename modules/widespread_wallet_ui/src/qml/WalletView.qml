import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtWebView
import "Resources.js" as Res

// Widespread wallet UI host — the shared wallet-ui web bundle running in a
// QtWebView, bridged to loaded backend modules (widespread_wallet, lez_faucet,
// …) through the same drain-pump pattern as logos-webview-app.
Item {
    id: root

    implicitWidth: 880
    implicitHeight: 640
    Layout.fillWidth: true
    Layout.fillHeight: true

    readonly property bool tabActive: typeof isActiveTab !== "undefined" ? isActiveTab : true
    property string statusText: "Widespread wallet"
    readonly property string bridgeScript: Res.bridgeScript
    readonly property string walletHtml: Res.walletHtml
    property bool pageLoaded: false
    property bool requestDrainInFlight: false

    function respondToJs(requestId, result, error) {
        var responseObj = { type: "logos_response", requestId: requestId };
        if (error) responseObj.error = error; else responseObj.result = result;
        webView.runJavaScript("window.postMessage(" + JSON.stringify(responseObj) + ", '*');");
    }

    function handleLogosRequest(moduleName, methodName, args, requestId) {
        if (typeof logos === "undefined" || !logos) {
            respondToJs(requestId, null, "logos API not available");
            return;
        }
        logos.callModuleAsync(moduleName, methodName, args, function(payload) {
            var parsed = null;
            if (typeof payload === "string" && payload.length > 0) {
                try { parsed = JSON.parse(payload); }
                catch (e) { respondToJs(requestId, null, "Failed to parse response: " + e); return; }
            }
            if (parsed && typeof parsed === "object" && "error" in parsed && !("result" in parsed))
                respondToJs(requestId, null, String(parsed.error));
            else
                respondToJs(requestId, parsed, null);
        });
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        Label {
            text: root.statusText
            Layout.fillWidth: true
            padding: 4
            background: Rectangle { color: "#16181d" }
            color: "#9aa4b2"
        }

        WebView {
            id: webView
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: root.tabActive

            Component.onCompleted: {
                if (root.walletHtml.length > 0) webView.loadHtml(root.walletHtml);
                else root.statusText = "wallet-ui bundle missing — run scripts/build-ui.sh";
            }

            onLoadingChanged: function(loadRequest) {
                root.pageLoaded = (loadRequest.status === WebView.LoadSucceededStatus);
                root.requestDrainInFlight = false;
                if (loadRequest.status === WebView.LoadSucceededStatus
                        && root.bridgeScript.length > 0) {
                    webView.runJavaScript(root.bridgeScript);
                } else if (loadRequest.status === WebView.LoadFailedStatus) {
                    root.statusText = "wallet-ui failed to load";
                }
            }
        }
    }

    Timer {
        interval: 30
        running: root.tabActive && root.pageLoaded
        repeat: true
        onTriggered: {
            if (!root.pageLoaded || root.requestDrainInFlight || webView.loading)
                return;
            root.requestDrainInFlight = true;
            try {
                webView.runJavaScript(
                    "(function(){ var d = (typeof _qtDrain === 'function') ? _qtDrain : (window.__logosBridge && window.__logosBridge.drain); return d ? d() : []; })();",
                    function(result) {
                        root.requestDrainInFlight = false;
                        if (!result || !result.length) return;
                        for (var i = 0; i < result.length; ++i) {
                            var payload = result[i];
                            root.handleLogosRequest(
                                payload.module || payload.plugin || "",
                                payload.method || "",
                                payload.args || [],
                                payload.requestId || payload.id || 0);
                        }
                    }
                );
            } catch (err) {
                root.requestDrainInFlight = false;
                console.warn("WalletView.qml: drain pump failed:", err);
            }
        }
    }
}
