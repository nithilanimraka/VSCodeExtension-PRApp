// src/analyzeViewManager.ts
import * as vscode from 'vscode';
import { getNonce } from './utils';
import { getCurrentRepositoryPath } from './gitUtils'; // Import helper

// Simple map to hold active panels (can be expanded)
const activeAnalyzerPanels = new Map<string, vscode.WebviewPanel>();
const VIEW_TYPE = 'gitRepoAnalyzerView';
const FASTAPI_URL = 'http://127.0.0.1:8000/analyze';

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
                    break;
                    case 'askQuestion':
                        const question = message.text;
                        console.log('Received question from analyzer webview:', question);
    
                        // Get the current repository path dynamically
                        const currentRepoPath = await getCurrentRepositoryPath();
                        if (!currentRepoPath) {
                            vscode.window.showErrorMessage("Could not determine the current Git repository path.");
                            panel.webview.postMessage({ command: 'addErrorMessage', text: "Failed to find Git repository path." });
                            return;
                        }
    
                        // --- Call FastAPI Backend ---
                        try {
                            // Dynamically import node-fetch because the extension uses CommonJS
                            const fetch = (await import('node-fetch')).default;
    
                            const response = await fetch(FASTAPI_URL, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Accept': 'text/plain', // Expecting plain text stream
                                },
                                body: JSON.stringify({
                                    repo_path: currentRepoPath,
                                    query: question
                                })
                            });
    
                            if (!response.ok) {
                                // Handle HTTP errors (like 4xx, 5xx)
                                const errorText = await response.text();
                                console.error(`FastAPI request failed: ${response.status} ${response.statusText}`, errorText);
                                panel.webview.postMessage({ command: 'addErrorMessage', text: `Server error (${response.status}): ${errorText || response.statusText}` });
                                return;
                            }
    
                            if (!response.body) {
                                console.error("FastAPI response body is null.");
                                panel.webview.postMessage({ command: 'addErrorMessage', text: "Received empty response from server." });
                                return;
                            }
    
                            // Signal start of bot message stream
                            panel.webview.postMessage({ command: 'startBotMessage' });
    
                            // --- FIX: Process the stream using for await...of ---
                            const decoder = new TextDecoder();
                            // Treat response.body as an AsyncIterable<Uint8Array> or Buffer
                            for await (const chunkBuffer of response.body) {
                                // Decode the chunk (assuming it's Uint8Array or Buffer)
                                // If chunkBuffer is already string, skip decoding
                                let chunkText: string;
                                if (typeof chunkBuffer === 'string') {
                                    chunkText = chunkBuffer;
                                } else {
                                    chunkText = decoder.decode(chunkBuffer, { stream: true });
                                }
                                // Send chunk to webview
                                panel.webview.postMessage({ command: 'addBotChunk', text: chunkText });
                            }
                            // --- End FIX ---

                            // Signal end of stream (optional, but good practice)
                            // The decoder needs a final call in case there were partial multi-byte chars
                            const finalChunk = decoder.decode();
                            if (finalChunk) {
                                panel.webview.postMessage({ command: 'addBotChunk', text: finalChunk });
                            }
                            panel.webview.postMessage({ command: 'endBotMessage' });
    
    
                        } catch (error: any) {
                            console.error("Error calling FastAPI backend:", error);
                            let errorMessage = "Failed to connect to the analysis server.";
                            if (error.code === 'ECONNREFUSED') {
                                errorMessage += " Please ensure the backend server is running.";
                            } else if (error instanceof Error) {
                                errorMessage += ` (${error.message})`;
                            }
                            panel.webview.postMessage({ command: 'addErrorMessage', text: errorMessage });
                        }
                        // --- End Call FastAPI Backend ---
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
        "What are the Contributor insights?",
        "Provide the Commit-Message Quality based on days of the week",
        "Give me the Recent activity / cadence",
        "Provide me the Risk & quality signals of the repository",
        "Give the Ownership & bus-factor of files"
        
    ];

    let questionsHtml = '';
    presetQuestions.forEach(q => {
        // Escape the question text properly for the data attribute
        const escapedQ = q.replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        questionsHtml += `<button class="preset-question-button" data-question="${escapedQ}">${q}</button>\n`;
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
            <h2>FAQs</h2>
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