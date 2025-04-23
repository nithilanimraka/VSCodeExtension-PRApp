// src/analyzeViewManager.ts
import * as vscode from 'vscode';
import { getNonce } from './utils';
import { getCurrentRepositoryPath } from './gitUtils'; // Import helper

// Simple map to hold active panels (can be expanded)
const activeAnalyzerPanels = new Map<string, vscode.WebviewPanel>();
const VIEW_TYPE = 'gitRepoAnalyzerView';

export async function createOrShowAnalyzerWebview(context: vscode.ExtensionContext) {
    const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;
    const repoPath = await getCurrentRepositoryPath(); // Get repo path for potential context

    // Use repo path as a unique identifier if available, otherwise a default key
    const panelId = repoPath || 'defaultAnalyzerPanel';
    const panelTitle = repoPath ? `Analyze: ${vscode.workspace.asRelativePath(repoPath)}` : "Analyze Git Repository";

    // If panel already exists, show it.
    const existingPanel = activeAnalyzerPanels.get(panelId);
    if (existingPanel) {
        console.log(`Revealing existing analyzer panel for: ${panelId}`);
        existingPanel.reveal(column);
        return;
    }

    // Otherwise, create a new panel.
    console.log(`Creating new analyzer panel for: ${panelId}`);
    const panel = vscode.window.createWebviewPanel(
        VIEW_TYPE,
        panelTitle,
        column,
        {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'), // Bundled JS/CSS
                vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist') // Codicons
            ],
            retainContextWhenHidden: true // Keep state when tab is not visible
        }
    );

    activeAnalyzerPanels.set(panelId, panel);

    // Set the webview's initial html content
    panel.webview.html = getAnalyzerWebviewHtml(context, panel.webview);

    // Listen for when the panel is disposed
    panel.onDidDispose(
        () => {
            console.log(`Disposing analyzer panel for: ${panelId}`);
            activeAnalyzerPanels.delete(panelId);
        },
        null,
        context.subscriptions
    );

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
        async message => {
            switch (message.command) {
                case 'webviewReady':
                    console.log('Analyzer webview is ready.');
                    // Optionally send initial data if needed
                    // panel.webview.postMessage({ command: 'initialData', ... });
                    break;
                case 'askQuestion':
                    const question = message.text;
                    console.log('Received question from analyzer webview:', question);

                    // --- Placeholder for backend interaction ---
                    // In a real scenario:
                    // 1. Show loading/thinking indicator in webview
                    //    panel.webview.postMessage({ command: 'showThinking' });
                    // 2. Send question to your FastAPI backend
                    //    const response = await sendToFastAPI(question, repoPath);
                    // 3. Send response back to webview
                    //    panel.webview.postMessage({ command: 'addBotMessage', text: response });

                    // For now, just echo the question back as a bot message
                    const echoResponse = `(Placeholder) You asked: "${question}"`;
                    panel.webview.postMessage({ command: 'addBotMessage', text: echoResponse });
                    return;

                case 'showError': // Allow webview to request showing errors
                    if (message.text) {
                        vscode.window.showErrorMessage(message.text);
                    }
                    return;
            }
        },
        undefined,
        context.subscriptions
    );
}


function getAnalyzerWebviewHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'analyzerMain.js'));
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'analyzerStyles.css'));
    const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
    const nonce = getNonce();

    const presetQuestions = [
        "Who's the most frequent contributor?",
        "Summarize the last change in the repository.",
        "Contributor insights",
        "Recent activity / cadence",
        "Risk & quality signals",
        "Ownership & bus-factor of files",
        "Commit-Message Quality & Hygiene"
    ];

    let questionsHtml = '';
    presetQuestions.forEach(q => {
        questionsHtml += `<button class="preset-question-button" data-question="${q}">${q}</button>\n`;
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="
        default-src 'none';
        style-src ${webview.cspSource} 'unsafe-inline';
        font-src ${webview.cspSource};
        img-src ${webview.cspSource} https: data:;
        script-src 'nonce-${nonce}';
    ">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${codiconCssUri}" rel="stylesheet" nonce="${nonce}" />
    <link href="${stylesUri}" rel="stylesheet" nonce="${nonce}">
    <title>Git Repository Analyzer</title>
</head>
<body>
    <div class="analyzer-container">
        <aside class="sidebar">
            <h2>REPOSITORY INSIGHTS</h2>
            <div class="preset-questions">
                ${questionsHtml}
            </div>
        </aside>

        <main class="chat-area">
            <div id="message-list" class="message-list">
                 <div class="message bot-message">
                    <span class="codicon codicon-hubot avatar"></span>
                    <div class="content">
                        <p>👋 Welcome to the Git Repository Assistant! I can help you analyze and understand the current repository.</p>
                        <p>Select a question from the sidebar or ask me anything about the current git repository.</p>
                    </div>
                 </div>
                 </div>

            <div class="input-area">
                <textarea id="question-input" placeholder="Ask me anything about the current git repository..." rows="1"></textarea>
                <button id="send-button" title="Send Message">
                    <span class="codicon codicon-send"></span>
                </button>
            </div>
        </main>
    </div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}