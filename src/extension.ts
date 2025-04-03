import * as vscode from 'vscode';
import { getGitHubSession, getOctokit } from './auth'; 
import { PrDataProvider } from './prDataProvider'; 
import { Octokit } from '@octokit/rest';
import type { PullRequestInfo } from './prDataProvider'; // Import the interface

let prDataProvider: PrDataProvider | undefined;
export function activate(context: vscode.ExtensionContext) {

    console.log('Congratulations, your extension "your-pr-extension" is now active!');

    // --- 1. Register the Tree Data Provider ---
    prDataProvider = new PrDataProvider();
    vscode.window.registerTreeDataProvider('yourPrViewId', prDataProvider); // Use ID from package.json

    // --- 2. Register Commands ---

    // Command to Refresh the View
    const refreshCommand = vscode.commands.registerCommand('yourExtension.refreshPrView', () => {
        prDataProvider?.refresh();
    });
    context.subscriptions.push(refreshCommand);

    // Command to Create a Pull Request (Example)
    const createPrCommand = vscode.commands.registerCommand('yourExtension.createPullRequest', async () => {
        const octokit = await getOctokit();
        if (!octokit) {
            vscode.window.showErrorMessage("Please sign in to GitHub first.");
            return;
        }

        // --- Basic Example: Get info using input boxes ---
        // In a real extension, you'd likely get branches from the Git API
        const baseBranch = await vscode.window.showInputBox({ prompt: 'Enter base branch (e.g., main)' });
        if (!baseBranch) return;
        const headBranch = await vscode.window.showInputBox({ prompt: 'Enter head branch (your current branch)' });
         if (!headBranch) return;
        const title = await vscode.window.showInputBox({ prompt: 'Enter PR Title' });
        if (!title) return;
        const body = await vscode.window.showInputBox({ prompt: 'Enter PR Body (optional)' });

        // --- Get repo owner/name (use the helper from PrDataProvider or similar) ---
        // const repoContext = await prDataProvider.getCurrentRepoContext(); // Need access or reimplement
        // if (!repoContext) return;
        const repoOwner = 'some-owner'; // Replace with actual logic
        const repoName = 'some-repo'; // Replace with actual logic

        try {
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Creating Pull Request...",
                cancellable: false
            }, async (progress) => {
                const response = await octokit.pulls.create({
                    owner: repoOwner,
                    repo: repoName,
                    title: title,
                    head: headBranch, // The branch the changes are on
                    base: baseBranch, // The branch to merge into
                    body: body,
                    // draft: false, // optional
                });

                if (response.status === 201) {
                    vscode.window.showInformationMessage(`Pull Request #${response.data.number} created successfully!`);
                    prDataProvider?.refresh(); // Refresh the view
                    // --- Optionally open the PR details view automatically ---
                    // const prInfo: PullRequestInfo = { /* map from response.data */ };
                    // vscode.commands.executeCommand('yourExtension.viewPullRequest', prInfo);
                } else {
                    vscode.window.showErrorMessage(`Failed to create PR (Status: ${response.status})`);
                }
            });
        } catch (err) {
            console.error("Error creating PR:", err);
            if(err instanceof Error) {
                vscode.window.showErrorMessage(`Failed to create Pull Request: ${err.message}`);
            } else {
                vscode.window.showErrorMessage(`Failed to create Pull Request: ${String(err)}`);
            }
        }
    });
    context.subscriptions.push(createPrCommand);

    // Command to View Pull Request Details (Opens Webview)
    const viewPrCommand = vscode.commands.registerCommand('yourExtension.viewPullRequest', (prInfo: PullRequestInfo) => {
        createOrShowPrDetailWebview(context.extensionUri, prInfo);
    });
    context.subscriptions.push(viewPrCommand);

    // Command to View Diff (Placeholder - choose implementation)
    const viewDiffCommand = vscode.commands.registerCommand('yourExtension.viewDiff', async (prInfo: PullRequestInfo) => {
        // Implementation depends on your choice (vscode.diff, Webview, etc.)
        vscode.window.showInformationMessage(`TODO: Implement Diff View for PR #${prInfo.number}`);
        // Example: Fetch diff content and show in webview or use vscode.diff
        await fetchAndShowDiff(context, prInfo);
    });
    context.subscriptions.push(viewDiffCommand);

     // Command for explicit Sign In (if needed by Tree View item)
     const signInCommand = vscode.commands.registerCommand('yourExtension.signIn', async () => {
         const session = await getGitHubSession(); // Trigger the auth flow
         if (session && prDataProvider) {
             await prDataProvider.initialize(); // Re-initialize provider with session
             prDataProvider.refresh();
         }
     });
     context.subscriptions.push(signInCommand);

}

// --- Webview Panel Management (Example for PR Details) ---
let prDetailPanel: vscode.WebviewPanel | undefined = undefined;

async function createOrShowPrDetailWebview(extensionUri: vscode.Uri, prInfo: PullRequestInfo) {
    const column = vscode.window.activeTextEditor
        ? vscode.window.activeTextEditor.viewColumn
        : undefined;

    // If we already have a panel, show it.
    if (prDetailPanel) {
        prDetailPanel.reveal(column);
        updateWebviewContent(prDetailPanel.webview, prInfo); // Update content if needed
        return;
    }

    // Otherwise, create a new panel.
    prDetailPanel = vscode.window.createWebviewPanel(
        'prDetailView', // Identifies the type of the webview. Used internally
        `PR #${prInfo.number}: ${prInfo.title}`, // Title of the panel displayed to the user
        column || vscode.ViewColumn.One, // Editor column to show the new webview panel in.
        {
            enableScripts: true, // Allow scripts for interactivity (fetching comments, etc.)
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] // If you have local CSS/JS
        }
    );

    updateWebviewContent(prDetailPanel.webview, prInfo);

    // Handle messages from the webview (e.g., user clicks a button in the webview)
    prDetailPanel.webview.onDidReceiveMessage(
        message => {
            switch (message.command) {
                case 'alert':
                    vscode.window.showErrorMessage(message.text);
                    return;
                // Add more cases to handle interactions
            }
        },
        undefined,
        // context.subscriptions // Ensure disposal linkage
    );


    // Reset panel variable when closed
    prDetailPanel.onDidDispose(
        () => {
            prDetailPanel = undefined;
        },
        null,
        // context.subscriptions
    );
}

// Function to generate and set HTML content for the webview
async function updateWebviewContent(webview: vscode.Webview, prInfo: PullRequestInfo) {
    webview.html = await getWebviewHtml(webview, prInfo); // Separate function for HTML generation
}

// Function to generate the HTML (fetch comments, diff here)
async function getWebviewHtml(webview: vscode.Webview, prInfo: PullRequestInfo): Promise<string> {
    const octokit = await getOctokit();
    let commentsHtml = 'Loading comments...';
    let diffHtml = 'Loading diff...'; // Placeholder for diff content

    if (octokit) {
        try {
            // Fetch Issue Comments (General PR comments)
            const issueComments = await octokit.issues.listComments({
                owner: prInfo.repoOwner,
                repo: prInfo.repoName,
                issue_number: prInfo.number,
            });
            // Fetch Review Comments (tied to lines of code)
            const reviewComments = await octokit.pulls.listReviewComments({
                owner: prInfo.repoOwner,
                repo: prInfo.repoName,
                pull_number: prInfo.number,
            });

            // Combine and format comments (this needs careful HTML structuring)
            commentsHtml = `<h3>Comments:</h3><ul>`;
            issueComments.data.forEach(c => {
                 commentsHtml += `<li><b>${c.user?.login}:</b> ${c.body}</li>`;
            });
             reviewComments.data.forEach(c => {
                 commentsHtml += `<li><b>${c.user?.login} (review):</b> ${c.body} (on ${c.path}:${c.line})</li>`;
             });
            commentsHtml += `</ul>`;

        } catch (e) {
            console.error("Failed to fetch comments:", e);
            if(e instanceof Error) {
                vscode.window.showErrorMessage(`Failed to fetch comments: ${e.message}`);
            }else{
                vscode.window.showErrorMessage(`Failed to fetch comments: ${String(e)}`);
            }
        }

        // --- Fetch Diff ---
        // Option A: Get Diff Content for Webview Display
        try {
             const diffResponse = await octokit.pulls.get({
                 owner: prInfo.repoOwner,
                 repo: prInfo.repoName,
                 pull_number: prInfo.number,
                 mediaType: { // Request the diff format
                     format: 'diff'
                 }
             });
             // The actual diff content is in diffResponse.data (as a string)
             // You'll need a JS library in the webview (like diff2html) or server-side processing
             // to render this nicely. For now, just show raw diff.
             diffHtml = `<h3>Diff:</h3><pre><code>${escapeHtml(diffResponse.data as any)}</code></pre>`;

        } catch(e) {
             console.error("Failed to fetch diff:", e);
             if(e instanceof Error) {
                 vscode.window.showErrorMessage(`Failed to fetch diff: ${e.message}`);
             } else {
                 vscode.window.showErrorMessage(`Failed to fetch diff: ${String(e)}`);
             }
        }


    } else {
        commentsHtml = "Cannot fetch comments: Not authenticated.";
        diffHtml = "Cannot fetch diff: Not authenticated.";
    }

    // Basic HTML structure - Enhance with CSS and potentially a frontend framework
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>PR #${prInfo.number}</title>
        <style>
           /* Add some basic styling */
           body { padding: 10px; }
           pre { background-color: #f0f0f0; padding: 5px; border: 1px solid #ccc; overflow-x: auto;}
           code { white-space: pre; }
        </style>
    </head>
    <body>
        <h1><a href="${prInfo.url}">#${prInfo.number}: ${prInfo.title}</a></h1>
        <p>Author: ${prInfo.author}</p>
        <hr>
        ${commentsHtml}
        <hr>
        ${diffHtml}

        </body>
    </html>`;
}

// Helper to escape HTML entities in the diff/comments
function escapeHtml(unsafe: string): string {
    if (typeof unsafe !== 'string') return '';
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
 }


// --- Diff Implementation (Alternative using vscode.diff) ---
async function fetchAndShowDiff(context: vscode.ExtensionContext, prInfo: PullRequestInfo) {
     const octokit = await getOctokit();
     if (!octokit) return;

     try {
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Fetching Diff..." }, async () => {

            // 1. Get PR details to find base and head commit SHAs
            const { data: pull } = await octokit.pulls.get({
                owner: prInfo.repoOwner,
                repo: prInfo.repoName,
                pull_number: prInfo.number,
            });
            const baseSha = pull.base.sha;
            const headSha = pull.head.sha;

            // 2. Get the list of files changed in the PR
            const { data: files } = await octokit.pulls.listFiles({
                 owner: prInfo.repoOwner,
                 repo: prInfo.repoName,
                 pull_number: prInfo.number,
            });

            if (!files || files.length === 0) {
                vscode.window.showInformationMessage("No changes detected in this pull request.");
                return;
            }

            // For simplicity, let's just diff the first file found.
            // A real extension would let the user pick or show all diffs.
            const file = files[0];

             if (file.status === 'added') {
                 // Handle added files - show content against empty
                 const { data: content } = await octokit.repos.getContent({ owner: prInfo.repoOwner, repo: prInfo.repoName, path: file.filename, ref: headSha });
                 const headContent = Buffer.from((content as any).content, 'base64').toString('utf8');
                 const headUri = vscode.Uri.parse(`pr-diff-head:/${file.filename}?sha=${headSha}`); // Virtual URI
                 // TODO: Register a TextDocumentContentProvider for 'pr-diff-head' scheme
                 vscode.window.showInformationMessage("Diffing added file - requires TextDocumentContentProvider setup");

             } else if (file.status === 'removed') {
                  // Handle removed files - show old content against empty
                  vscode.window.showInformationMessage("Diffing removed file - requires TextDocumentContentProvider setup");
             } else { // Modified, renamed etc.
                // 3. Fetch file content for base and head commits
                // Note: getContent might fail if file is too large
                const { data: baseContentData } = await octokit.repos.getContent({ owner: prInfo.repoOwner, repo: prInfo.repoName, path: file.filename, ref: baseSha });
                const { data: headContentData } = await octokit.repos.getContent({ owner: prInfo.repoOwner, repo: prInfo.repoName, path: file.filename, ref: headSha });

                const baseContent = Buffer.from((baseContentData as any).content, 'base64').toString('utf8');
                const headContent = Buffer.from((headContentData as any).content, 'base64').toString('utf8');

                // 4. Create temporary files or virtual documents (using TextDocumentContentProvider is cleaner)
                // Quick & Dirty: Temporary Files (Clean up afterwards!)
                const baseUri = await createTempFile(context, `${prInfo.number}-${baseSha}-${file.filename}`, baseContent);
                const headUri = await createTempFile(context, `${prInfo.number}-${headSha}-${file.filename}`, headContent);


                // 5. Execute the built-in diff command
                const diffTitle = `${file.filename} (PR #${prInfo.number})`;
                vscode.commands.executeCommand('vscode.diff', baseUri, headUri, diffTitle);
             }

        });
     } catch (err) {
         console.error("Error fetching or showing diff:", err);
         if(err instanceof Error) {
            vscode.window.showErrorMessage(`Failed to show diff: ${err.message}`);
         }
     }
}

// Helper for temp files (Needs cleanup logic in deactivate)
let tempFiles: vscode.Uri[] = [];
async function createTempFile(context: vscode.ExtensionContext, fileName: string, content: string): Promise<vscode.Uri> {
    const safeFileName = fileName.replace(/[\/\\]/g, '_'); // Basic sanitization
    // Use globalStorageUri for more persistent temp files if needed across sessions
    const uri = vscode.Uri.joinPath(context.globalStorageUri, safeFileName);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    tempFiles.push(uri); // Track for cleanup
    return uri;
}


// Called when the extension is deactivated (e.g., VS Code closing)
export function deactivate() {
    // Clean up temporary diff files
    Promise.all(tempFiles.map(uri => vscode.workspace.fs.delete(uri)))
        .then(() => console.log("Cleaned up temporary diff files."))
        .catch(err => console.error("Error cleaning up temp files:", err));
    tempFiles = []; // Clear the array

     // Dispose web panel if it exists
     if (prDetailPanel) {
        prDetailPanel.dispose();
     }
} // Make sure to export deactivate