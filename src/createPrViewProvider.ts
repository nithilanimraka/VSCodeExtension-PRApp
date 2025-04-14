import * as vscode from 'vscode';
import { getNonce } from './utils'; 
import { getOctokit } from './auth';
import type { PullRequestInfo } from './prDataProvider';
import { showDiffBetweenBranches } from './prDescriptionProvider';

import { GitInfo, ChangedFile, FromCreatePrWebviewMessage, ComparisonFile } from './types'; 



// Get the Git API 
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

    public static readonly viewType = 'yourCreatePrViewId'; 

    private _view?: vscode.WebviewView;
    private _extensionContext: vscode.ExtensionContext;
    private _currentGitInfo: GitInfo = {}; // Store last known git info
    private _visibilityChangeListener?: vscode.Disposable;

    constructor(context: vscode.ExtensionContext) {
        this._extensionContext = context;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        console.log("CreatePrViewProvider: Resolving webview view."); 
        this._view = webviewView;

        // Dispose of the old listener if resolveWebviewView is called again for the same provider instance
        this._visibilityChangeListener?.dispose();

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionContext.extensionUri, 'dist', 'webview'), // Bundled output
                vscode.Uri.joinPath(this._extensionContext.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist') // Codicons
            ]
        };

        // Set initial HTML 
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        this._visibilityChangeListener = webviewView.onDidChangeVisibility(() => {
            // Check if the view associated with THIS provider instance is now visible
            if (this._view?.visible) {
                console.log('Create PR View became visible. Refreshing data...');
                // Re-fetch and send data when the view becomes visible
                this.prepareAndSendData(); // Use prepareAndSendData to fetch potentially fresh data
            } else {
                 console.log('Create PR View became hidden.'); 
            }
        });

        // Clean up listener when the view itself is disposed 
         const disposeListener = webviewView.onDidDispose(() => {
              console.log("Create PR View disposed, cleaning up visibility listener.");
              this._visibilityChangeListener?.dispose();
              this._visibilityChangeListener = undefined; // Clear reference
              this._view = undefined; // Clear view reference
              disposeListener.dispose(); // Dispose this listener itself
         });

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data: FromCreatePrWebviewMessage) => {
            switch (data.command) {
                case 'webviewReady': {
                    console.log('Create PR webview is ready.');
                    break;
                }
                case 'getChangedFiles': {
                    // Webview requested updated file list
                    const files = await this.getChangedFilesFromGit();
                     if (this._view && files) {
                         this._view.webview.postMessage({ command: 'loadFormData', data: { changedFiles: files } });
                     }
                    break;
                    }

                case 'showCreatePrDiff': { 
                    const diffData = data.data;
                    if (diffData && diffData.owner && diffData.repo && diffData.base && diffData.head && diffData.filename && diffData.status) {
                            console.log(`Provider received showCreatePrDiff request for: ${diffData.filename}`);
                        showDiffBetweenBranches(
                            this._extensionContext, 
                            diffData.owner,
                            diffData.repo,
                            diffData.base,
                            diffData.head,
                            diffData.filename,
                            diffData.status 
                        );
                    } else {
                            console.error("Received incomplete data for showCreatePrDiff", diffData);
                            vscode.window.showErrorMessage("Could not show diff: Missing information.");
                    }
                        break;
                }
                case 'createPrRequest': {
                    // Execute the actual PR creation
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
                            
                                    // 1. Construct the PullRequestInfo object from the response
                                    const prInfo: PullRequestInfo = {
                                        id: response.data.id, // Added id field
                                        number: response.data.number,
                                        title: response.data.title,
                                        url: response.data.html_url,
                                        author: response.data.user?.login || 'unknown',
                                        repoOwner: owner, // Use owner determined earlier
                                        repoName: repo, // Use repo determined earlier
                                        // Add other fields from response.data if needed by your detail view
                                    };

                                    vscode.commands.executeCommand('yourExtension.viewPullRequest', prInfo, true); 

                                    // Execute the command to open the detail view
                                    vscode.commands.executeCommand('yourExtension.viewPullRequest', prInfo);


                                    // Refresh the main PR list view
                                    vscode.commands.executeCommand('yourExtension.refreshPrView');

                                    //  Reset the Create PR form by sending fresh initial data
                                    await this.prepareAndSendData();

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
                }
                case 'cancelPr': {
                    console.log("Provider received cancelPr request.");
                    // Clear stored info so the form doesn't repopulate automatically if reopened
                    this._currentGitInfo = {};
                    // Send empty data to reset the webview form fields via loadFormData logic
                    this.sendDataToWebview({
                         // Send undefined/empty for fields handled by webview's loadFormData
                         branches: [], // Causes "No branches found"
                         changedFiles: [], // Causes "No changes detected"
                         // Base/head will be undefined, title/desc cleared by webview
                    });

                    // Switch focus back to the main list view
                    await vscode.commands.executeCommand('yourPrViewId.focus');
                    // Set the context variable back to false to hide this view
                    await vscode.commands.executeCommand('setContext', 'yourExtension:createPrViewVisible', false);
                    break;
                }

                case 'compareBranches': {
                    // Get owner, repo, AND branches from stored info
                    const owner = this._currentGitInfo.owner;
                    const repo = this._currentGitInfo.repo;
                    const branches = this._currentGitInfo.branches; // Get the stored list

                    // Check we have all necessary info, including the branches list
                    if (owner && repo && data.base && data.head && branches) {
                        console.log(`Provider received compare request: ${data.base}...${data.head}`);
                        const comparisonFiles = await this.getComparisonFiles(
                            owner,
                            repo,
                            data.base, 
                            data.head 
                        );
                        console.log("Comparison result files:", comparisonFiles.length);

                        // Send files, branches, and current selections back 
                        this.sendDataToWebview({
                            changedFiles: comparisonFiles,
                            branches: branches, // Send the list of branches
                            baseBranch: data.base, // Include current base selection
                            headBranch: data.head  // Include current head selection
                        });

                    } else {
                        // Log details if something is missing
                        console.warn("Missing data for branch comparison.", {
                             owner: !!owner,
                             repo: !!repo,
                             base: data.base,
                             head: data.head,
                             branchesAvailable: !!branches
                         });
                        // Send back empty files, but still include branches to prevent clearing
                         this.sendDataToWebview({
                             changedFiles: [],
                             branches: this._currentGitInfo.branches || [], // Send stored branches or empty
                             baseBranch: data.base, // Still send selections
                             headBranch: data.head
                         });
                    }
                    break;
                }

                case 'showError':{
                    if (data.text) {
                        vscode.window.showErrorMessage(data.text); // Show the error using VS Code UI
                    }
                    break;
                }
            }
        });
    }

    // Method called by the command in extension.ts to trigger loading data
    public async prepareAndSendData() {
        console.log("CreatePrViewProvider: prepareAndSendData called."); 
        if (!this._view) {
            console.log("prepareAndSendData: View not available yet, attempting focus...");
            // Try to focus the view to trigger resolveWebviewView if not already resolved
             try {
                 await vscode.commands.executeCommand(`${CreatePrViewProvider.viewType}.focus`);
             } catch (e) {
                  console.warn("Focus command failed (maybe view container not visible):", e);
             }
             // It might take a moment for the view to resolve after focus
             await new Promise(resolve => setTimeout(resolve, 150));
             if (!this._view) {
                  console.error("Create PR View still not available after focus attempt.");
                  return;
             }
             console.log("prepareAndSendData: View became available after focus/delay.");
        } else {
             console.log("prepareAndSendData: View already available.");
        }

        // Ensure view is visible before proceeding 
        if (!this._view.visible) {
            console.log("prepareAndSendData: View is not visible, skipping data send.");
            return;
        }

        console.log("prepareAndSendData: Fetching current git info...");
         try {
            this._currentGitInfo = await this.getCurrentGitInfo(); // Get latest info
            console.log("prepareAndSendData: Git info fetched, sending to webview.");
            this.sendDataToWebview(this._currentGitInfo);
         } catch (error) {
              console.error("prepareAndSendData: Error fetching git info:", error);
              this.sendDataToWebview({}); // Send empty object
         }
    }

     // Helper to send data (avoids repeating the check)
    private sendDataToWebview(gitInfo: GitInfo | Partial<GitInfo>) { 
        if (this._view?.visible) {
            // Ensure owner and repo from the provider's state are included if they exist and aren't already in the partial gitInfo
            const dataToSend = {
                ...gitInfo, // Include data passed in (like changedFiles)
                owner: this._currentGitInfo.owner ?? (gitInfo as GitInfo).owner, // Prefer provider's state
                repo: this._currentGitInfo.repo ?? (gitInfo as GitInfo).repo,   // Prefer provider's state
            };
             console.log("Sending data to visible webview:", dataToSend);
             this._view.webview.postMessage({ command: 'loadFormData', data: dataToSend });

        } else {
            console.warn("Attempted to send data, but webview is not available.");
        }
    }

    // Method to compare branches 
    private async getComparisonFiles(owner: string, repo: string, base: string, head: string): Promise<ChangedFile[]> {
        const octokit = await getOctokit();
        if (!octokit) {
            vscode.window.showErrorMessage("GitHub authentication needed to compare branches.");
            return [];
        }

        try {
            const response = await octokit.repos.compareCommits({
                owner,
                repo,
                base,
                head,
            });

            // Check if the response contains the expected data
            if (response.status === 200 && response.data.files) {
                return response.data.files.map((file: ComparisonFile) => ({ 
                    path: file.filename,
                    status: this.mapComparisonStatus(file.status),
                }));
            } else {
                    console.warn(`Compare branches response missing 'files' array or status not 200. Status: ${response.status}`);
                    // Handle cases like identical branches where 'files' might be empty or missing
                    if (response.data.status === 'identical') {
                        return []; 
                    }
                    vscode.window.showWarningMessage(`Could not retrieve file changes for ${base}...${head}.`);
                    return [];
            }
        } catch (error: any) {
             console.error(`Error comparing branches ${base}...${head}:`, error);
             const message = error.status === 404
                 ? `Could not compare: One or both branches ('${base}', '${head}') not found.`
                 : `Error comparing branches: ${error.message || error}`;
             vscode.window.showErrorMessage(message);
             return [];
        }
    }

    // Map GitHub's comparison status strings to our single chars
    private mapComparisonStatus(status?: string): ChangedFile['status'] {
        switch (status) {
            case 'added': return 'A';
            case 'removed': return 'D';
            case 'modified': return 'M';
            case 'renamed': return 'R';
            case 'changed': return 'M'; 
            default: return '?';
        }
    }

    // Method to fetch branches
    private async getRepoBranches(owner: string, repo: string): Promise<string[]> {
        const octokit = await getOctokit();
        if (!octokit) {
            console.error("Octokit not available to fetch branches.");
            return [];
        }
        try {
            const branches = await octokit.paginate(octokit.repos.listBranches, {
                owner,
                repo,
                per_page: 100,
            });
            return branches.map(branch => branch.name);
        } catch (error) {
            console.error(`Failed to fetch branches for ${owner}/${repo}:`, error);
            vscode.window.showErrorMessage(`Failed to fetch branches: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    //  Git Interaction Logic 
    private async getCurrentGitInfo(): Promise<GitInfo> {
        const api = await getGitApi();
        if (!api) return {}; // Return empty if API not available

        const repo = api.repositories[0]; // Use first repo
        const head = repo.state.HEAD;
        const headBranch = head?.name;

        // check remote tracking branch
        let baseBranch: string | undefined = undefined;
        if (head?.upstream?.remote && head?.upstream?.name) {
             // If upstream is set, use it as base 
             baseBranch = head.upstream.name;
        } else {
             // Fallback: check common names like main/master on origin
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

        if (!owner || !repoName) {
            console.warn("Could not determine GitHub owner/repo from origin remote URL:", remoteUrl);
            vscode.window.showWarningMessage("Could not determine GitHub repository from 'origin' remote. Please ensure it's configured correctly.");
            // Return empty branches but still try to get local changes
            const localChanges = await this.getChangedFilesFromGit(repo);
            return { headBranch, baseBranch, owner, repo: repoName, remoteUrl, changedFiles: localChanges, branches: [] }; // Return empty branches list
        }

        // Fetch branches and changed files 
        let branches: string[] = [];
        if (owner && repoName) {
            branches = await this.getRepoBranches(owner, repoName);
             // Ensure default base/head are valid branches, adjust if not
             if (baseBranch && !branches.includes(baseBranch)) {
                 console.warn(`Default base branch "${baseBranch}" not found in remote branches. Resetting.`);
                 baseBranch = branches.find(b => b === 'main' || b === 'master') || branches[0]; // Fallback
             }
             if (headBranch && !branches.includes(headBranch)) {
                 console.warn(`Current head branch "${headBranch}" not found in remote branches? This might indicate local-only branch.`);
             }
        }

        const changedFiles = await this.getChangedFilesFromGit(repo); // Pass repo object

        console.log(`Detected ${changedFiles.length} changed files in provider:`, changedFiles);

        return { headBranch, baseBranch, remoteUrl, owner, repo: repoName, changedFiles, branches };
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

            if (!change.resourceUri) {
                console.warn("Skipping change object without resourceUri:", change);
                return; // Skip this iteration
            }

            const filePath = change.resourceUri.fsPath; 
            let statusChar: ChangedFile['status'] = '?';
            const tooltip = change.decorations?.tooltip;
    
            if (typeof tooltip === 'string') {
                // Infer status from tooltip text 
                if (tooltip.includes('Modified')) statusChar = 'M';
                else if (tooltip.includes('Untracked')) statusChar = 'A'; 
                else if (tooltip.includes('Added')) statusChar = 'A';
                else if (tooltip.includes('Deleted')) statusChar = 'D';
                else if (tooltip.includes('Renamed')) statusChar = 'R';
                else if (tooltip.includes('Copied')) statusChar = 'C';
                 else {
                     console.warn(`Unrecognized tooltip status for ${change.resourceUri.fsPath}: ${tooltip}`);
                     statusChar = '?'; // Fallback if tooltip text isn't recognized
                 }
            } else {
                // Fallback if tooltip is missing or not a string.
                console.warn(`Missing or invalid tooltip for ${change.resourceUri.fsPath}, unable to determine status reliably.`);
                statusChar = '?';
            }
    
            // Use change.resourceUri.fsPath for the unique key and path
            uniqueChanges.set(change.resourceUri.fsPath, { path: filePath, status: statusChar });
        });
    
        return Array.from(uniqueChanges.values());
    }


    // HTML Generation 
    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'dist', 'webview', 'createPrMain.js'));
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'dist', 'webview', 'createPrStyles.css'));
        const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
        const nonce = getNonce();

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
                        <label for="base-branch-select">Base Branch:</label>
                        <select id="base-branch-select" name="base-branch-select" required>
                            <option value="">Loading branches...</option>
                        </select>
                    </div>

                    <div class="form-group">
                    <label for="head-branch-select">Merge Branch:</label>
                    <select id="head-branch-select" name="head-branch-select" required>
                        <option value="">Loading branches...</option>
                        </select>
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