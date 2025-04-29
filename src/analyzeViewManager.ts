import * as vscode from 'vscode';
import * as path from 'path';
import { getNonce } from './utils';
import { getCurrentRepositoryPath } from './gitUtils';
import { v4 as uuidv4 } from 'uuid'; 
import fetch from 'node-fetch'; 


// Store panel and its session ID
interface ActiveAnalyzerPanelInfo {
    panel: vscode.WebviewPanel;
    sessionId: string;
}
const activeAnalyzerPanels = new Map<string, ActiveAnalyzerPanelInfo>(); // Keyed by panelId (repoPath or default)

const VIEW_TYPE = 'gitRepoAnalyzerView';
const FASTAPI_URL = 'http://127.0.0.1:8000/analyze';
const FASTAPI_END_SESSION_URL = 'http://127.0.0.1:8000/end_session';

export async function createOrShowAnalyzerWebview(context: vscode.ExtensionContext) {
    const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;
    const repoPath = await getCurrentRepositoryPath();

    const repoName = repoPath ? path.basename(repoPath) : undefined;
    const panelId = repoPath || 'defaultAnalyzerPanel'; // Use repo path or default as the KEY for the map
    const panelTitle = repoName ? `Analyze: ${repoName}` : "Analyze Git Repository";

    const existingPanelInfo = activeAnalyzerPanels.get(panelId);
    if (existingPanelInfo) {
        console.log(`Revealing existing analyzer panel for: ${panelId}`);
        existingPanelInfo.panel.reveal(column);
        // Ensure title is up-to-date if repo context changed somehow (edge case)
        existingPanelInfo.panel.title = panelTitle;
        return;
    }

    // Generate a unique session ID for the new panel
    const sessionId = uuidv4();
    console.log(`Creating new analyzer panel for: ${panelId} with session ID: ${sessionId}`);

    const panel = vscode.window.createWebviewPanel(
        VIEW_TYPE,
        panelTitle,
        column,
        {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'),
                vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')
            ],
            retainContextWhenHidden: true
        }
    );

    // Store the panel and its session ID
    const panelInfo: ActiveAnalyzerPanelInfo = { panel, sessionId };
    activeAnalyzerPanels.set(panelId, panelInfo);

    panel.webview.html = getAnalyzerWebviewHtml(context, panel.webview);

    panel.onDidDispose(
        async () => { 
            console.log(`Disposing analyzer panel for: ${panelId} (Session ID: ${sessionId})`);
            activeAnalyzerPanels.delete(panelId); // Remove panel from map

            // Call backend to end the session 
            try {
                // Use the specific sessionId associated with the disposed panel
                console.log(`Notifying backend to end session: ${sessionId}`);
                const response = await fetch(FASTAPI_END_SESSION_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: sessionId })
                });
                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`Failed to end session ${sessionId} on backend: ${response.status} ${response.statusText}`, errorText);
                } else {
                    console.log(`Session ${sessionId} ended successfully on backend.`);
                }
            } catch (error: any) {
                console.error(`Error calling end_session endpoint for ${sessionId}:`, error);
            }

        },
        null,
        context.subscriptions
    );

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
        async message => {
            switch (message.command) {
                case 'webviewReady':
                    console.log(`Analyzer webview ready for session: ${sessionId}`);
                    break;
                case 'askQuestion':
                    const question = message.text;
                    console.log(`Session ${sessionId}: Received question:`, question);

                    const currentRepoPath = await getCurrentRepositoryPath();
                    if (!currentRepoPath) {
                        vscode.window.showErrorMessage("Could not determine the current Git repository path.");
                        panel.webview.postMessage({ command: 'addErrorMessage', text: "Failed to find Git repository path." });
                        return;
                    }

                    try {
                        const response = await fetch(FASTAPI_URL, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Accept': 'text/plain',
                            },
                            body: JSON.stringify({
                                repo_path: currentRepoPath,
                                query: question,
                                session_id: sessionId 
                            })
                        });

                        if (!response.ok) {
                            const errorText = await response.text();
                            console.error(`Session ${sessionId}: FastAPI request failed: ${response.status} ${response.statusText}`, errorText);
                            panel.webview.postMessage({ command: 'addErrorMessage', text: `Server error (${response.status}): ${errorText || response.statusText}` });
                            return;
                        }

                        if (!response.body) {
                            console.error(`Session ${sessionId}: FastAPI response body is null.`);
                            panel.webview.postMessage({ command: 'addErrorMessage', text: "Received empty response from server." });
                            return;
                        }

                        panel.webview.postMessage({ command: 'startBotMessage' });

                        const decoder = new TextDecoder();
                        for await (const chunkBuffer of response.body) {
                            let chunkText: string;
                            if (typeof chunkBuffer === 'string') {
                                chunkText = chunkBuffer;
                            } else {
                                // Ensure chunkBuffer is correctly typed
                                chunkText = decoder.decode(chunkBuffer as Buffer | Uint8Array, { stream: true });
                            }
                            panel.webview.postMessage({ command: 'addBotChunk', text: chunkText });
                        }

                        const finalChunk = decoder.decode();
                        if (finalChunk) {
                            panel.webview.postMessage({ command: 'addBotChunk', text: finalChunk });
                        }
                        panel.webview.postMessage({ command: 'endBotMessage' });


                    } catch (error: any) {
                        console.error(`Session ${sessionId}: Error calling FastAPI backend:`, error);
                        let errorMessage = "Failed to connect to the analysis server.";
                        if (error.code === 'ECONNREFUSED') {
                            errorMessage += " Please ensure the backend server is running.";
                        } else if (error instanceof Error) {
                            errorMessage += ` (${error.message})`;
                        }
                        panel.webview.postMessage({ command: 'addErrorMessage', text: errorMessage });
                    }
                    return;

                case 'showError':
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