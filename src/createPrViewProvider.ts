import * as vscode from 'vscode';
import { getNonce } from './utils';
import { getOctokit } from './auth';
import type { PullRequestInfo } from './prDataProvider';
import { showDiffBetweenBranches } from './prDescriptionProvider';
import { isGitRepositoryAvailable, getGitApi } from './gitUtils';
import { GitInfo, ChangedFile, ComparisonFile, FromCreatePrWebviewMessage, ToCreatePrWebviewMessage, ReviewItemData } from './types'; // Use specific types
import type { Endpoints } from "@octokit/types";
import fetch from 'node-fetch';
import { createOrShowReviewResultPanel } from './reviewResultViewProvider'; // Import the new panel creator

const BACKEND_REVIEW_URL = 'http://127.0.0.1:8000/code-review'; // Backend URL

// Helper function to fetch diff content
async function fetchDiffContent(owner: string, repo: string, base: string, head: string): Promise<string | null> {
    const octokit = await getOctokit();
    if (!octokit) {
        vscode.window.showErrorMessage("GitHub authentication needed to fetch diff.");
        return null;
    }
    try {
        console.log(`Workspaceing diff content for ${owner}/${repo}: ${base}...${head}`);
        const response = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
            owner,
            repo,
            basehead: `${base}...${head}`,
            headers: { accept: 'application/vnd.github.v3.diff' }
        });
        console.log(`Diff fetch status: ${response.status}`);

        if (response.status === 200 && typeof response.data === 'string') {
            return response.data;
        } else if (response.status === 200 && typeof response.data === 'object' && (response.data as any).files?.length === 0 && (response.data as any).status === 'identical') {
             // Handle case where compareCommits returns JSON for identical branches even with diff header
             console.log(`Branches ${base} and ${head} are identical or have no textual diff.`);
             return ""; // Return empty string for no difference
        } else {
            console.warn(`Unexpected response status or format when fetching diff: ${response.status}`);
            vscode.window.showWarningMessage(`Could not retrieve diff content (Status: ${response.status}).`);
            return null;
        }
    } catch (error: any) {
        console.error(`Error fetching diff content (${base}...${head}):`, error);
        const message = error.status === 404 ? `Could not fetch diff: One or both refs ('${base}', '${head}') not found.` : `Error fetching diff: ${error.message || String(error)}`;
        vscode.window.showErrorMessage(message);
        return null;
    }
}

// Minimal Interface for Git Ref
interface GitRef {
    type: number; // 0 for HEAD, 1 for Remote Head, 2 for Tag
    name?: string;
    commit?: string;
    remote?: string;
    upstream?: {
        name: string;
        remote: string;
    };
}

export class CreatePrViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'yourCreatePrViewId';

    private _view?: vscode.WebviewView;
    private _extensionContext: vscode.ExtensionContext;
    private _currentGitInfo: GitInfo = {};
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

        this._visibilityChangeListener?.dispose();

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionContext.extensionUri, 'dist', 'webview'),
                vscode.Uri.joinPath(this._extensionContext.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        this._visibilityChangeListener = webviewView.onDidChangeVisibility(() => {
            if (this._view?.visible) {
                console.log('Create PR View became visible. Refreshing data...');
                this.prepareAndSendData();
            } else {
                console.log('Create PR View became hidden.');
            }
        });

        const disposeListener = webviewView.onDidDispose(() => {
             console.log("Create PR View disposed, cleaning up visibility listener.");
             this._visibilityChangeListener?.dispose();
             this._visibilityChangeListener = undefined;
             this._view = undefined;
             disposeListener.dispose();
        });

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data: FromCreatePrWebviewMessage) => {
            switch (data.command) {
                 case 'webviewReady': {
                     console.log('Create PR webview is ready.');
                     if (this._view?.visible) {
                        this.prepareAndSendData();
                     }
                     break;
                 }
                case 'getChangedFiles': {
                    console.warn("'getChangedFiles' command received, but comparison is preferred.");
                    break;
                }
                case 'showCreatePrDiff': {
                    const diffData = data.data;
                    if (diffData && diffData.owner && diffData.repo && diffData.base && diffData.head && diffData.filename && diffData.status) {
                        console.log(`Provider received showCreatePrDiff request for: ${diffData.filename} (${diffData.base}...${diffData.head})`);
                        showDiffBetweenBranches(
                            this._extensionContext, diffData.owner, diffData.repo,
                            diffData.base, diffData.head, diffData.filename, diffData.status
                        );
                    } else {
                        console.error("Received incomplete data for showCreatePrDiff", diffData);
                        vscode.window.showErrorMessage("Could not show diff: Missing information.");
                    }
                    break;
                }
                case 'createPrRequest': {
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
                                    const prInfo: PullRequestInfo = {
                                        id: response.data.id, number: response.data.number, title: response.data.title,
                                        url: response.data.html_url, author: response.data.user?.login || 'unknown',
                                        repoOwner: owner, repoName: repo,
                                    };
                                    vscode.commands.executeCommand('yourExtension.viewPullRequest', prInfo, true);
                                    vscode.commands.executeCommand('yourExtension.refreshPrView');
                                    await this.prepareAndSendData(); // Reset form

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
                    this._currentGitInfo = {}; // Clear stored info
                    this.sendDataToWebview({
                        branches: [], changedFiles: [], baseBranch: undefined, headBranch: undefined
                    });
                    await vscode.commands.executeCommand('yourPrViewId.focus');
                    await vscode.commands.executeCommand('setContext', 'yourExtension:createPrViewVisible', false);
                    break;
                }
                case 'compareBranches': {
                    const owner = this._currentGitInfo.owner;
                    const repo = this._currentGitInfo.repo;
                    const branches = this._currentGitInfo.branches;
                    let comparisonFiles: ChangedFile[] = [];

                    if (owner && repo && data.base && data.head && branches) {
                        console.log(`Provider received compare request: ${data.base}...${data.head}`);
                        try {
                            comparisonFiles = await this.getComparisonFiles(owner, repo, data.base, data.head);
                            console.log(`Comparison successful, found ${comparisonFiles.length} changed files.`);
                         } catch (error) {
                             console.error(`Error caught while comparing branches (${data.base}...${data.head})`);
                         }
                        console.log("Sending comparison results/status back to webview.");
                        this.sendDataToWebview({
                            changedFiles: comparisonFiles,
                            baseBranch: data.base,
                            headBranch: data.head
                        });

                    } else {
                        console.warn("Missing data for branch comparison.", { owner: !!owner, repo: !!repo, base: data.base, head: data.head, branchesAvailable: !!branches });
                        this.sendDataToWebview({
                            changedFiles: [],
                            baseBranch: data.base,
                            headBranch: data.head,
                        });
                    }
                    break;
                }

                case 'submitCodeReview': {
                    const { base, head } = data.data;
                    const owner = this._currentGitInfo.owner;
                    const repo = this._currentGitInfo.repo;

                    if (!owner || !repo || !base || !head || base === head) {
                        vscode.window.showWarningMessage("Please select two different branches to start the review.");
                        webviewView.webview.postMessage({ command: 'reviewFinished', success: false });
                        return;
                    }

                    console.log(`Processing Code Review Submission for ${owner}/${repo}: ${base}...${head}`);
                    let reviewList: ReviewItemData[] | null = null;
                    let success = false;

                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: `Analyzing code between ${base} and ${head}...`,
                        cancellable: false
                    }, async (progress) => {
                        try {
                            progress.report({ message: "Fetching diff from GitHub..." });
                            const diffContent = await fetchDiffContent(owner, repo, base, head);

                            if (diffContent === null) {
                                success = false; return; // Error already shown
                            }
                            if (diffContent.length === 0) {
                                progress.report({ message: "No changes found." });
                                vscode.window.showInformationMessage(`No textual differences found between ${base} and ${head}.`);
                                success = true;
                                reviewList = []; // Empty list indicates no issues found
                                return;
                            }

                            progress.report({ message: "Sending changes to analysis backend..." });
                            const backendResponse = await fetch(BACKEND_REVIEW_URL, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                                body: JSON.stringify({ diff_content: diffContent })
                            });

                            if (!backendResponse.ok) {
                                const errorText = await backendResponse.text();
                                throw new Error(`Backend analysis failed (${backendResponse.status}): ${errorText}`);
                            }

                            try {
                                // Expecting a JSON array matching ReviewItemData[]
                                const parsedJson = await backendResponse.json();
                                if (!Array.isArray(parsedJson)) {
                                     throw new Error(`Backend response was not a JSON array.`);
                                }
                                reviewList = parsedJson as ReviewItemData[]; // Assert the type
                             } catch (jsonError) {
                                 console.error("Failed to parse backend response as JSON:", jsonError);
                                 throw new Error(`Failed to parse review results: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`);
                             }

                            success = true;
                            progress.report({ message: "Analysis complete." });

                        } catch (error: any) {
                            console.error("Error during code review processing:", error);
                            vscode.window.showErrorMessage(`Code Review Failed: ${error.message || String(error)}`);
                            // Create a single error item to display
                             reviewList = [{
                                 fileName: "Review Error",
                                 codeSegmentToFix: "N/A",
                                 start_line_with_prefix: "?", end_line_with_prefix: "?",
                                 language: "text",
                                 issue: `Code Review Failed: ${error.message || String(error)}`,
                                 suggestion: "Please check the backend server logs and ensure it's running correctly, and that the diff content was valid.",
                                 severity: "error"
                             }];
                            success = false;
                        }
                    }); // End progress indicator

                    // Show results in the new panel
                    if (reviewList !== null) {
                        createOrShowReviewResultPanel(this._extensionContext, reviewList, base, head);
                    }

                    // Notify webview to re-enable button
                    webviewView.webview.postMessage({ command: 'reviewFinished', success: success });
                    break;
                }

                case 'showError': {
                    if (data.text) {
                        vscode.window.showErrorMessage(data.text);
                    }
                    break;
                }
            }
        });

        if(webviewView.visible) {
           this.prepareAndSendData();
        }
    }

    public async prepareAndSendData() {
        console.log("CreatePrViewProvider: prepareAndSendData called.");
        if (!this._view) {
            console.log("prepareAndSendData: View not available yet, attempting focus...");
            try {
                await vscode.commands.executeCommand(`${CreatePrViewProvider.viewType}.focus`);
            } catch (e) {
                 console.warn("Focus command failed (maybe view container not visible):", e);
            }
            await new Promise(resolve => setTimeout(resolve, 150));
            if (!this._view) {
                 console.error("Create PR View still not available after focus attempt.");
                 return;
            }
            console.log("prepareAndSendData: View became available after focus/delay.");
        } else if (!this._view.visible) {
            console.log("prepareAndSendData: View is not visible, skipping data send.");
            return;
        }

        console.log("prepareAndSendData: Fetching current git info...");
        try {
            this._currentGitInfo = await this.getCurrentGitInfo();
            console.log("prepareAndSendData: Git info fetched, sending to webview for initial load.");
            this.sendDataToWebview({
                branches: this._currentGitInfo.branches,
                baseBranch: this._currentGitInfo.baseBranch,
                headBranch: this._currentGitInfo.headBranch,
                owner: this._currentGitInfo.owner,
                repo: this._currentGitInfo.repo,
                changedFiles: []
            });
        } catch (error) {
             console.error("prepareAndSendData: Error fetching git info:", error);
             this.sendDataToWebview({ branches: [] });
        }
    }

    private sendDataToWebview(data: Partial<GitInfo>) {
        if (this._view?.visible) {
            const ownerRepo = (this._currentGitInfo.owner && this._currentGitInfo.repo)
                ? { owner: this._currentGitInfo.owner, repo: this._currentGitInfo.repo }
                : {};

            const dataToSend: Partial<GitInfo> = { ...ownerRepo, ...data };
            if (data.branches) { dataToSend.branches = data.branches; }

            console.log("Sending data to Create PR webview:", dataToSend);
            const message: ToCreatePrWebviewMessage = { command: 'loadFormData', data: dataToSend };
            this._view.webview.postMessage(message);
        } else {
            console.warn("Attempted to send data, but Create PR webview is not available or not visible.");
        }
    }

    private async getComparisonFiles(owner: string, repo: string, base: string, head: string): Promise<ChangedFile[]> {
        console.log(`[Provider] getComparisonFiles called for ${owner}/${repo}: ${base}...${head}`);
        const octokit = await getOctokit();
        if (!octokit) {
            console.error("[Provider] getComparisonFiles: Octokit not available.");
            vscode.window.showErrorMessage("GitHub authentication needed to compare branches.");
            throw new Error("GitHub authentication failed.");
        }
        try {
            console.log(`[Provider] Calling octokit.repos.compareCommits...`);
            type CompareCommitsResponseType = Endpoints["GET /repos/{owner}/{repo}/compare/{basehead}"]["response"];
            const response: CompareCommitsResponseType = await octokit.repos.compareCommits({ owner, repo, base, head });
            console.log(`[Provider] Octokit compareCommits response status: ${response.status}`);

            const files = response.data.files;
            if (Array.isArray(files)) {
                 console.log(`[Provider] Mapping ${files.length} files from API response.`);
                 return files.map((file) => ({
                    path: file.filename,
                    status: this.mapComparisonStatus(file.status),
                 }));
            } else if (response.data.status === 'identical') {
                console.log(`[Provider] Branches ${base} and ${head} are identical.`);
                return [];
            } else {
                const warningMsg = `Could not retrieve file changes for ${base}...${head}. Status: ${response.status}. Files data missing or not an array.`;
                console.warn(`[Provider] ${warningMsg}`);
                return [];
            }
        } catch (error: any) {
            console.error(`[Provider] Error in octokit.repos.compareCommits (${base}...${head}):`, error);
            const message = error.status === 404
                ? `Could not compare: One or both branches ('${base}', '${head}') not found on remote.`
                : `Error comparing branches: ${error.message || String(error)}`;
            vscode.window.showErrorMessage(message);
            throw error;
        }
    }


    private mapComparisonStatus(status?: string): ChangedFile['status'] {
        switch (status) {
            case 'added': return 'A';
            case 'removed': return 'D';
            case 'modified': return 'M';
            case 'renamed': return 'R';
            case 'changed': return 'M';
            case 'copied': return 'C';
            default: return '?';
        }
    }

    private async getRepoBranches(owner: string, repo: string): Promise<string[]> {
        const octokit = await getOctokit();
        if (!octokit) {
            console.error("Octokit not available to fetch branches.");
            return [];
        }
        try {
            const branches = await octokit.paginate(octokit.repos.listBranches, { owner, repo, per_page: 100 });
            return branches.map(branch => branch.name);
        } catch (error) {
            console.error(`Failed to fetch branches for ${owner}/${repo}:`, error);
            vscode.window.showErrorMessage(`Failed to fetch branches: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    private async getCurrentGitInfo(): Promise<GitInfo> {
        const api = await getGitApi();
        if (!api || api.repositories.length === 0) {
            console.warn("Git API not available or no repositories found.");
            if (this._view?.visible) {
                 vscode.window.showWarningMessage("No Git repository found in the workspace. Please open a folder containing a Git repository.");
            }
            return { changedFiles: [], branches: [] };
        }

        const repo = api.repositories[0];
        const head: GitRef | undefined = repo.state.HEAD; // Use GitRef type
        const headBranch = head?.name;

        let baseBranch: string | undefined = undefined;
        const originMain = repo.state.refs.find((ref: GitRef) => ref.type === 0 && ref.name === 'origin/main');
        const originMaster = repo.state.refs.find((ref: GitRef) => ref.type === 0 && ref.name === 'origin/master');
        if (originMain) { baseBranch = 'main'; }
        else if (originMaster) { baseBranch = 'master'; }

        // Try to refine base based on upstream if available and different from head
        if (head?.upstream?.remote === 'origin' && head?.upstream?.name && head.upstream.name !== headBranch) {
            baseBranch = head.upstream.name;
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
            vscode.window.showWarningMessage("Could not determine GitHub repository from 'origin' remote.");
            return { headBranch, baseBranch, remoteUrl, owner, repo: repoName, changedFiles: [], branches: [] };
        }

        let branches: string[] = [];
        try {
            branches = await this.getRepoBranches(owner, repoName);
            if (baseBranch && !branches.includes(baseBranch)) {
                console.warn(`Default base branch "${baseBranch}" not found in remote branches. Resetting.`);
                baseBranch = branches.find(b => b === 'main' || b === 'master') || (branches.length > 0 ? branches[0] : undefined);
            }
            if (headBranch && !branches.includes(headBranch)) {
                console.warn(`Current head branch "${headBranch}" not found in remote branches? This might indicate local-only branch.`);
            }
        } catch (branchError) {
             console.error("Error fetching branches during initial load:", branchError);
             return { headBranch, baseBranch, remoteUrl, owner, repo: repoName, changedFiles: [], branches: [] };
        }

        return { headBranch, baseBranch, remoteUrl, owner, repo: repoName, changedFiles: [], branches };
    }


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
                        <label for="base-branch-select">Base Branch (Merge Into):</label>
                        <select id="base-branch-select" name="base-branch-select" required>
                            <option value="">Loading branches...</option>
                        </select>
                    </div>

                    <div class="form-group">
                    <label for="head-branch-select">Compare Branch (Merge From):</label>
                    <select id="head-branch-select" name="head-branch-select" required>
                        <option value="">Loading branches...</option>
                        </select>
                    </div>

                    <div class="form-group">
                         <label for="pr-title">Title:</label>
                        <input type="text" id="pr-title" name="pr-title" required>
                    </div>

                    <div class="form-group">
                        <label for="pr-description">Description (Optional):</label>
                        <textarea id="pr-description" name="pr-description" rows="4"></textarea>
                    </div>

                     <div class="form-group">
                        <label>Files Changed (<span id="files-changed-count">0</span>):</label>
                        <div id="files-changed-list" class="files-list" aria-live="polite">
                            <p>Select branches to compare...</p>
                        </div>
                     </div>

                     <div class="form-group code-review-button-group">
                         <button id="code-review-button" type="button" disabled>Code Review</button>
                     </div>

                    <div class="button-group bottom-buttons">
                        <button id="cancel-button" type="button">Cancel</button>
                        <button id="create-button" type="submit" disabled>Create Pull Request</button>
                    </div>
                </div>

                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}