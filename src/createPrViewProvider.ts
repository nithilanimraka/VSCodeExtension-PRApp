// src/createPrViewProvider.ts
import * as vscode from 'vscode';
import { getNonce } from './utils'; // Assuming getNonce is accessible (e.g., in utils.ts)
import { getOctokit } from './auth';
import type { Endpoints } from "@octokit/types"; // Import types for file data if needed

// Define types for Git info we might need
interface GitInfo {
    headBranch?: string;
    baseBranch?: string;
    remoteUrl?: string;
    owner?: string;
    repo?: string;
    changedFiles?: ChangedFile[]; // Define ChangedFile below
}

// Simple type for changed files (expand as needed)
interface ChangedFile {
    path: string;
    status: 'A' | 'M' | 'D' | 'R' | 'C' | '?'; // Added, Modified, Deleted, Renamed, Copied, Untracked/Unknown
}


// Define the shape of messages sent TO the webview
type ToCreatePrWebviewMessage =
    | { command: 'loadFormData'; data: GitInfo }; // Send initial data

// Define the shape of messages sent FROM the webview
type FromCreatePrWebviewMessage =
    | { command: 'webviewReady' }
    | { command: 'createPrRequest'; data: { base: string; head: string; title: string; body: string; } }
    | { command: 'cancelPr' }
    | { command: 'getChangedFiles' }; // Webview can request file list

// --- NEW: Helper function to safely get the Git API ---
async function getGitApi() {
    try {
        const extension = vscode.extensions.getExtension('vscode.git');
        if (!extension) {
            vscode.window.showErrorMessage('Git extension (vscode.git) not found. Please install or enable it.');
            return undefined;
        }

        if (!extension.isActive) {
            await extension.activate();
        }

        const api = extension.exports.getAPI(1);
        if (api.repositories.length === 0) {
             vscode.window.showWarningMessage("No Git repositories found in the current workspace.");
            return undefined;
        }
        return api; // Return the API object

    } catch (error) {
        console.error("Failed to get Git API:", error);
        vscode.window.showErrorMessage(`Failed to initialize Git features: ${error}`);
        return undefined;
    }
}

export class CreatePrViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'yourCreatePrViewId'; // Matches ID in package.json

    private _view?: vscode.WebviewView;
    private _extensionContext: vscode.ExtensionContext;
    private _currentGitInfo: GitInfo = {}; // Store last known git info

    constructor(context: vscode.ExtensionContext) {
        this._extensionContext = context;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionContext.extensionUri, 'dist', 'webview'), // Bundled output
                vscode.Uri.joinPath(this._extensionContext.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist') // Codicons
            ]
        };

        // Set initial HTML (can be loading state or the form shell)
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data: FromCreatePrWebviewMessage) => {
            switch (data.command) {
                case 'webviewReady':
                    // Webview is ready, if we have initial data, send it
                    console.log('Create PR webview is ready.');
                    if (this._currentGitInfo.headBranch) { // Check if we have data to send
                        this.sendDataToWebview(this._currentGitInfo);
                    } else {
                         // Maybe trigger a fetch if opened directly?
                         await this.prepareAndSendData();
                    }
                    break;
                case 'getChangedFiles':
                    // Webview requested updated file list
                    const files = await this.getChangedFilesFromGit();
                     if (this._view && files) {
                         this._view.webview.postMessage({ command: 'loadFormData', data: { changedFiles: files } });
                     }
                    break;
                case 'createPrRequest':
                    // --- Execute the actual PR creation ---
                    const octokit = await getOctokit();
                    const owner = this._currentGitInfo.owner;
                    const repo = this._currentGitInfo.repo;

                    if (!octokit || !owner || !repo) {
                        vscode.window.showErrorMessage("Cannot create PR. GitHub connection or repository info missing.");
                        return;
                    }
                    try {
                        await vscode.window.withProgress(
                            { location: vscode.ProgressLocation.Notification, title: "Creating Pull Request...", cancellable: false },
                            async () => {
                                const response = await octokit.pulls.create({
                                    owner: owner,
                                    repo: repo,
                                    title: data.data.title,
                                    head: data.data.head,
                                    base: data.data.base,
                                    body: data.data.body
                                });
                                if (response.status === 201) {
                                    vscode.window.showInformationMessage(`Pull Request #${response.data.number} created successfully!`);
                                    // TODO: Maybe close this view or clear the form?
                                    // Optionally refresh the *other* PR list view
                                    vscode.commands.executeCommand('yourExtension.refreshPrView');
                                } else {
                                    vscode.window.showErrorMessage(`Failed to create PR (Status: ${response.status})`);
                                }
                            }
                        );
                    } catch (err: any) {
                        console.error("Error creating PR:", err);
                        vscode.window.showErrorMessage(`Failed to create Pull Request: ${err.message || err}`);
                    }
                    break;
                case 'cancelPr':
                    // TODO: Decide what cancel means (clear form, close view?)
                    vscode.window.showInformationMessage("PR Creation Cancelled.");
                    // Maybe clear the form by sending empty data?
                     this.sendDataToWebview({ headBranch: undefined, baseBranch: undefined, changedFiles: [] });
                    break;
            }
        });
    }

    // Method called by the command in extension.ts to trigger loading data
    public async prepareAndSendData() {
        if (!this._view) {
            // Try to focus the view to trigger resolveWebviewView if not already resolved
            vscode.commands.executeCommand('yourCreatePrViewId.focus');
             // It might take a moment for the view to resolve, maybe add a small delay or retry?
             await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
             if (!this._view) {
                  console.error("Create PR View not available to send data.");
                  vscode.window.showWarningMessage("Could not open Create PR form. Please click the activity bar icon.");
                  return;
             }
        }

         this._currentGitInfo = await this.getCurrentGitInfo(); // Get latest info
         this.sendDataToWebview(this._currentGitInfo);

    }

     // Helper to send data (avoids repeating the check)
    private sendDataToWebview(gitInfo: GitInfo) {
         if (this._view) {
             this._view.webview.postMessage({ command: 'loadFormData', data: gitInfo });
         }
    }


    // --- Git Interaction Logic (Use the helper function) ---
    private async getCurrentGitInfo(): Promise<GitInfo> {
        // --- Use the helper function ---
        const api = await getGitApi();
        if (!api) return {}; // Return empty if API not available
        // --- End Use helper ---

        const repo = api.repositories[0]; // Use first repo
        const head = repo.state.HEAD;
        const headBranch = head?.name;

        // Improved base branch logic - check remote tracking branch
        let baseBranch: string | undefined = undefined;
        if (head?.upstream?.remote && head?.upstream?.name) {
             // If upstream is set, use it as base (common workflow)
             baseBranch = head.upstream.name;
        } else {
             // Fallback: check common names like main/master on origin
             // This is still a guess and might need user input eventually
             const originMain = repo.state.refs.find((ref: any) => ref.type === 0 && ref.name === 'origin/main'); // Type=0 for head
             const originMaster = repo.state.refs.find((ref: any) => ref.type === 0 && ref.name === 'origin/master');
             if(originMain) baseBranch = 'main';
             else if (originMaster) baseBranch = 'master';
        }


        const remoteUrl = repo.state.remotes.find((r: any) => r.name === 'origin')?.fetchUrl;

        let owner: string | undefined;
        let repoName: string | undefined;
        if (remoteUrl && remoteUrl.includes('github.com')) {
            const match = remoteUrl.match(/github\.com[/:](.*?)\/(.*?)(?:\.git)?$/);
            if (match && match.length >= 3) {
                owner = match[1];
                repoName = match[2];
            }
        }

        const changedFiles = await this.getChangedFilesFromGit(repo); // Pass repo object

        return { headBranch, baseBranch, remoteUrl, owner, repo: repoName, changedFiles };
    }

    private async getChangedFilesFromGit(repository?: any): Promise<ChangedFile[]> {
        let repo = repository;
        if (!repo) {
            const api = await getGitApi(); // Use helper defined previously
            if (!api) return [];
            repo = api.repositories[0];
        }
    
        const workingTreeChanges = repo.state.workingTreeChanges as vscode.SourceControlResourceState[];
        const indexChanges = repo.state.indexChanges as vscode.SourceControlResourceState[];
    
        const allChanges = [...workingTreeChanges, ...indexChanges];
        const uniqueChanges = new Map<string, ChangedFile>();
    
        allChanges.forEach(change => {
            let statusChar: ChangedFile['status'] = '?'; // Default to unknown
    
            // --- Rely primarily on the tooltip provided by the Git extension ---
            const tooltip = change.decorations?.tooltip;
    
            if (typeof tooltip === 'string') {
                // Infer status from tooltip text (adjust keywords based on actual tooltips you see)
                if (tooltip.includes('Modified')) statusChar = 'M';
                else if (tooltip.includes('Untracked')) statusChar = 'A'; // Treat Untracked as Added for PR context
                else if (tooltip.includes('Added')) statusChar = 'A';
                else if (tooltip.includes('Deleted')) statusChar = 'D';
                else if (tooltip.includes('Renamed')) statusChar = 'R';
                else if (tooltip.includes('Copied')) statusChar = 'C';
                 // You might encounter others like 'Conflict', 'Ignored', 'Submodule'
                 else {
                     console.warn(`Unrecognized tooltip status for ${change.resourceUri.fsPath}: ${tooltip}`);
                     statusChar = '?'; // Fallback if tooltip text isn't recognized
                 }
            } else {
                // Fallback if tooltip is missing or not a string.
                // You could potentially inspect change.decorations.iconPath or other decorations here
                // but for now, we'll mark it as unknown.
                console.warn(`Missing or invalid tooltip for ${change.resourceUri.fsPath}, unable to determine status reliably.`);
                statusChar = '?';
            }
            // --- End status determination based on decorations ---
    
            // Use change.resourceUri.fsPath for the unique key and path
            uniqueChanges.set(change.resourceUri.fsPath, { path: change.resourceUri.fsPath, status: statusChar });
        });
    
        return Array.from(uniqueChanges.values());
    }


    // --- HTML Generation ---
    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'dist', 'webview', 'createPrMain.js'));
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'dist', 'webview', 'createPrStyles.css'));
        const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
        const nonce = getNonce();

        // Basic HTML structure for the form - Adapt based on the screenshot
        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${codiconCssUri}" rel="stylesheet" />
                <link href="${stylesUri}" rel="stylesheet">
                <title>Create PR</title>
            </head>
            <body>
                <div class="create-pr-form">
                    <h2>Create Pull Request</h2>

                    <div class="form-group">
                        <label for="base-branch">Base Branch:</label>
                        <input type="text" id="base-branch" name="base-branch" readonly>
                        </div>

                    <div class="form-group">
                        <label for="head-branch">Merge Branch:</label>
                        <input type="text" id="head-branch" name="head-branch" readonly>
                    </div>

                    <div class="form-group">
                         <label for="pr-title">Title:</label>
                        <input type="text" id="pr-title" name="pr-title" required>
                    </div>

                    <div class="form-group">
                        <label for="pr-description">Description:</label>
                        <textarea id="pr-description" name="pr-description" rows="4"></textarea>
                    </div>

                     <div class="form-group">
                        <label>Files Changed (<span id="files-changed-count">0</span>):</label>
                        <div id="files-changed-list" class="files-list">
                            <p>Loading files...</p>
                        </div>
                     </div>


                    <div class="button-group">
                        <button id="cancel-button" type="button">Cancel</button>
                        <button id="create-button" type="submit">Create</button>
                    </div>
                </div>

                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}

// Helper function (move to a utils.ts file eventually)
// function getNonce() {
//     let text = '';
//     const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
//     for (let i = 0; i < 32; i++) {
//         text += possible.charAt(Math.floor(Math.random() * possible.length));
//     }
//     return text;
// }