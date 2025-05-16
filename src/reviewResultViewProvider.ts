// project/frontend/src/reviewResultViewProvider.ts
import * as vscode from 'vscode';
import { getNonce } from './utils'; // Assuming utils.ts exists and exports getNonce
import type { ReviewItemData } from './types'; // Import the review structure type

// Type for messages sent TO this webview
type ToReviewResultWebviewMessage =
    | { command: 'showReviewResults'; data: ReviewItemData[] };

// Module-level variable to hold the reference to the panel.
// This allows us to reuse the panel if it already exists.
let reviewResultPanel: vscode.WebviewPanel | undefined = undefined;

/**
 * Creates a new webview panel for displaying review results, or reveals an existing one.
 * @param context The extension context.
 * @param reviewData The array of review data objects from the backend.
 * @param baseBranch Optional base branch name for the panel title.
 * @param headBranch Optional head branch name for the panel title.
 */
export function createOrShowReviewResultPanel(
    context: vscode.ExtensionContext,
    reviewData: ReviewItemData[],
    baseBranch?: string, // Pass branch info for title
    headBranch?: string
) {
    const column = vscode.window.activeTextEditor
        ? vscode.window.activeTextEditor.viewColumn // Show beside active editor if possible
        : undefined;

    // Create a more informative title using branch names if available
    const title = (baseBranch && headBranch)
        ? `Code Review (${baseBranch}...${headBranch})`
        : "Code Review Results";

    // If we already have a panel, show it and update its content.
    if (reviewResultPanel) {
        console.log("Revealing existing review panel and updating data.");
        reviewResultPanel.title = title; // Update title in case branches changed
        reviewResultPanel.reveal(column);
        // Send the new data to the existing panel's webview
        reviewResultPanel.webview.postMessage({ command: 'showReviewResults', data: reviewData });
        return;
    }

    // Otherwise, create a new panel.
    console.log("Creating new review panel.");
    reviewResultPanel = vscode.window.createWebviewPanel(
        'codeReviewResultView', // Identifies the type of the webview. Used internally
        title, // Title of the panel displayed to the user
        column || vscode.ViewColumn.Beside, // Editor column to show the new webview panel in.
        {
            // Enable javascript in the webview
            enableScripts: true,
            // Restrict the webview to only loading content from allowed directories
             localResourceRoots: [
                 vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'), // Compiled webview JS/CSS
                 vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist') // Allow codicons
             ],
             // Keep the webview's state even when it's not visible
             retainContextWhenHidden: true
        }
    );

    // Set the webview's initial HTML content
    reviewResultPanel.webview.html = getReviewResultWebviewHtml(context, reviewResultPanel.webview);

    // Listen for messages from the webview
    reviewResultPanel.webview.onDidReceiveMessage(
        message => {
            switch (message.command) {
                case 'webviewReady':
                    console.log('Review Result Webview signaled ready. Posting initial data.');
                    // Send the review data ONLY after the webview confirms it's ready
                    reviewResultPanel?.webview.postMessage({ command: 'showReviewResults', data: reviewData });
                    return;
                // Handle other messages from the webview if needed (e.g., copy clicks, links)
                // case 'copyCode':
                //     vscode.env.clipboard.writeText(message.code);
                //     vscode.window.showInformationMessage('Code copied to clipboard!');
                //     return;
            }
        },
        undefined,
        context.subscriptions
    );

    // Reset the panel variable when the panel is closed by the user
    reviewResultPanel.onDidDispose(
        () => {
            console.log("Review Result Panel disposed.");
            reviewResultPanel = undefined;
        },
        null,
        context.subscriptions
    );
}


/**
 * Generates the HTML content for the review result webview panel.
 * Includes necessary CSP, scripts, and styles.
 * @param context Extension context for resource URIs.
 * @param webview The webview instance.
 * @returns HTML string.
 */
function getReviewResultWebviewHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
    // Get URIs for local resources
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'reviewResultMain.js'));
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'reviewResultStyles.css'));
    const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
    const nonce = getNonce();

    // Define CDN URIs for highlight.js
    const highlightCssUri = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css';
    const highlightScriptUri = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js';

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="
            default-src 'none';
            style-src ${webview.cspSource} 'unsafe-inline' https://cdnjs.cloudflare.com;
            font-src ${webview.cspSource};
            script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com;
            img-src ${webview.cspSource} https: data:;
        ">
        <link href="${codiconCssUri}" rel="stylesheet" nonce="${nonce}" />
        <link href="${stylesUri}" rel="stylesheet" nonce="${nonce}">
        <link href="${highlightCssUri}" rel="stylesheet" nonce="${nonce}" />
        <title>Code Review Results</title>
    </head>
    <body>
        <h1>AI Code Review Results</h1>
        <div id="review-list-container">
            <p>Loading review...</p> </div>

        <script nonce="${nonce}" src="${highlightScriptUri}"></script>
        <script nonce="${nonce}" src="${scriptUri}"></script>

         </body>
    </html>`;
}