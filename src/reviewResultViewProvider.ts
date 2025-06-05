// project/frontend/src/reviewResultViewProvider.ts
import * as vscode from 'vscode';
import { getNonce } from './utils'; // Assuming utils.ts exists and exports getNonce
import type { ReviewItemData } from './types'; // Import the review structure type
import * as fs from 'fs';
import * as path from 'path';

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

// Add this function to convert review data to markdown
function convertReviewToMarkdown(reviewData: ReviewItemData[]): string {
    let markdown = `# Code Review Results\n\n`;
    
    reviewData.forEach((review, index) => {
        markdown += `## ${index + 1}. ${review.fileName || 'Unknown File'}\n`;
        
        // Line numbers
        const startLineInfo = parseLinePrefix(review.start_line_with_prefix);
        const endLineInfo = parseLinePrefix(review.end_line_with_prefix);
        const lineRangeStr = startLineInfo.num === endLineInfo.num
            ? `${startLineInfo.sign}${startLineInfo.num}`
            : `${startLineInfo.sign}${startLineInfo.num} to ${endLineInfo.sign}${endLineInfo.num}`;
        
        markdown += `**Lines:** ${lineRangeStr}\n\n`;
        
        // Issue details
        markdown += `### Issue\n${review.issue}\n\n`;
        markdown += `**Severity:** ${review.severity}\n\n`;
        
        // Code segment
        if (review.codeSegmentToFix) {
            markdown += `### Original Code\n\`\`\`${review.language || ''}\n${review.codeSegmentToFix}\n\`\`\`\n\n`;
        }
        
        // Suggestion
        markdown += `### Suggestion\n${review.suggestion}\n\n`;
        
        // Suggested code
        if (review.suggestedCode) {
            markdown += `### Suggested Code\n\`\`\`${review.language || ''}\n${review.suggestedCode}\n\`\`\`\n\n`;
        }
        
        markdown += `---\n\n`;
    });
    
    return markdown;
}

function parseLinePrefix(prefix: string | undefined | null): { num: number; sign: '+' | '-' | ' ' } {
    if (!prefix) {
        return { num: 0, sign: ' ' };
    }
    const sign = prefix.startsWith('+') ? '+' : prefix.startsWith('-') ? '-' : ' ';
    const numStr = prefix.replace(/^[+-]/, '').trim();
    const num = parseInt(numStr, 10);
    return { num: isNaN(num) ? 0 : num, sign };
}

async function exportReviewAsMarkdown(reviewData: ReviewItemData[], context: vscode.ExtensionContext) {
    try {
        // Get workspace folder
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder found to save the markdown file.');
            return;
        }

        // Ask user for file location
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(workspaceFolders[0].uri, 'code-review-results.md'),
            filters: {
                'Markdown': ['md']
            },
            title: 'Save Code Review as Markdown'
        });

        if (!uri) {
            return; // User cancelled
        }

        // Convert to markdown
        const markdownContent = convertReviewToMarkdown(reviewData);

        // Write file
        await vscode.workspace.fs.writeFile(uri, Buffer.from(markdownContent));
        
        vscode.window.showInformationMessage(`Code review saved as Markdown: ${uri.fsPath}`);
    } catch (error) {
        console.error('Error exporting markdown:', error);
        vscode.window.showErrorMessage('Failed to export code review as Markdown.');
    }
}

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
                case 'exportMarkdown':
                    exportReviewAsMarkdown(reviewData, context);
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
        <button id="export-md-button" class="export-button">
                <span class="codicon codicon-markdown"></span> Export as Markdown
            </button>
        <div id="review-list-container">
            <p>Loading review...</p> </div>
            

        <script nonce="${nonce}" src="${highlightScriptUri}"></script>
        <script nonce="${nonce}" src="${scriptUri}"></script>

         </body>
    </html>`;
}