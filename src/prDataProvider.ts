import * as vscode from 'vscode';
import { getOctokit } from './auth'; // Assuming auth functions are in auth.ts
import { Octokit } from '@octokit/rest'; // Import Octokit type if needed

// Interface for basic PR info (expand as needed)
export interface PullRequestInfo {
    id: number;
    number: number;
    title: string;
    url: string;
    author: string;
    repoOwner: string;
    repoName: string;
    // Add other relevant fields: state, created_at, etc.
}

export class PrDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {

    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private octokit: Octokit | undefined;
    private currentUser: string | undefined;

    constructor() {
       this.initialize();
    }

    async initialize() {
        // Get authenticated Octokit instance when provider is created
        this.octokit = await getOctokit();
        if (this.octokit) {
            try {
                const { data: { login } } = await this.octokit.users.getAuthenticated();
                this.currentUser = login;
                this.refresh(); // Initial data load
            } catch (e) {
                vscode.window.showErrorMessage('Failed to get authenticated GitHub user.');
                console.error(e);
            }
        }
    }

    refresh(): void {
        // Trigger a refresh of the tree view
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        // Return the element itself, as we are creating TreeItems directly
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!this.octokit || !this.currentUser) {
             // Not authenticated yet or failed, maybe return a "Sign in" item
             const signInItem = new vscode.TreeItem("Sign in to GitHub");
             signInItem.command = {
                 command: 'yourExtension.signIn', // You'll need to register this command
                 title: "Sign In"
             };
             // Optionally handle the sign in command to call getGitHubSession again
             return [signInItem];
        }

        if (element) {
            // If we have a parent element (e.g., a category), return its children (PRs)
            if (element.contextValue === 'prCategory' && element.label) {
                 return this.getPullRequestsForCategory(element.label as string);
            }
            // Add more conditions if you have deeper levels
            return [];
        } else {
            // If no element, return the top-level categories (similar to the screenshot)
            return Promise.resolve([
                new CategoryItem("Waiting For My Review", vscode.TreeItemCollapsibleState.Collapsed),
                new CategoryItem("Assigned To Me", vscode.TreeItemCollapsibleState.Collapsed),
                new CategoryItem("Created By Me", vscode.TreeItemCollapsibleState.Collapsed),
                new CategoryItem("All Open", vscode.TreeItemCollapsibleState.Collapsed)
                // Add "Local Pull Request Branches" if you implement that logic
            ]);
        }
    }

    private async getPullRequestsForCategory(categoryLabel: string): Promise<vscode.TreeItem[]> {
        if (!this.octokit || !this.currentUser) return [];

        let searchQuery = '';
        const repoContext = await this.getCurrentRepoContext(); // Helper needed to get current repo

        if (!repoContext) {
            // Handle case where not in a repo or can't determine it
            return [new vscode.TreeItem("Open a GitHub repository to see PRs")];
        }

        // Construct GitHub search query based on category
        // Example queries (adjust based on your exact needs and GitHub search syntax)
        const repoFilter = `repo:${repoContext.owner}/${repoContext.repo}`;
        switch (categoryLabel) {
            case "Waiting For My Review":
                searchQuery = `is:open is:pr ${repoFilter} review-requested:${this.currentUser}`;
                break;
            case "Assigned To Me":
                searchQuery = `is:open is:pr ${repoFilter} assignee:${this.currentUser}`;
                break;
            case "Created By Me":
                searchQuery = `is:open is:pr ${repoFilter} author:${this.currentUser}`;
                break;
            case "All Open":
                searchQuery = `is:open is:pr ${repoFilter}`;
                break;
            default:
                return []; // Unknown category
        }

        try {
            const result = await this.octokit.search.issuesAndPullRequests({
                q: searchQuery,
                per_page: 20 // Limit results for performance
            });

            if (result.data.items.length === 0) {
                 return [new vscode.TreeItem(`0 pull requests in this category`, vscode.TreeItemCollapsibleState.None)];
            }

            return result.data.items.map(pr => {
                 // Adapt this based on the structure returned by the search API
                 const prInfo: PullRequestInfo = {
                     id: pr.id,
                     number: pr.number,
                     title: pr.title,
                     url: pr.html_url,
                     author: pr.user?.login || 'unknown',
                     repoOwner: repoContext.owner, // Assuming search context is reliable
                     repoName: repoContext.repo,
                 };
                 return new PullRequestItem(prInfo, vscode.TreeItemCollapsibleState.None);
            });

        } catch (error) {
            console.error(`Error fetching PRs for category "${categoryLabel}":`, error);
            if(error instanceof Error) {
            vscode.window.showErrorMessage(`Failed to fetch PRs: ${error.message}`);
            }
            return [new vscode.TreeItem("Error fetching pull requests")];
        }
    }

     // --- Helper Function (Example - Needs refinement) ---
     // This needs robust logic to find the GitHub remote and parse owner/repo
     private async getCurrentRepoContext(): Promise<{ owner: string; repo: string } | undefined> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return undefined;

        const workspaceFolder = folders[0].uri; // Simplistic: assumes first folder

        try {
            // This is a very basic way; a robust solution uses the Git extension API
            // or parses .git/config manually or uses a git CLI wrapper.
            const gitConfigPath = vscode.Uri.joinPath(workspaceFolder, '.git/config');
            const configContentBytes = await vscode.workspace.fs.readFile(gitConfigPath);
            const configContent = new TextDecoder().decode(configContentBytes);

            // Very basic parsing (prone to errors with complex configs)
            const remoteUrlMatch = /\[remote "origin"\]\s*url = (?:git@github\.com:|https:\/\/github\.com\/)([\w-]+)\/([\w-]+)(?:\.git)?/m.exec(configContent);
             if (remoteUrlMatch && remoteUrlMatch.length >= 3) {
                return { owner: remoteUrlMatch[1], repo: remoteUrlMatch[2] };
            }
        } catch (e) {
            console.warn("Could not read or parse .git/config to find remote origin.", e);
        }
        vscode.window.showWarningMessage("Could not determine GitHub repository origin.");
        return undefined;
     }
     // --- End Helper ---
}

// --- Tree Item Classes ---

class CategoryItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.contextValue = 'prCategory'; // Used to identify this item type in getChildren
        this.tooltip = `Pull requests: ${label}`;
    }
    // You can add icons here using `iconPath`
}

export class PullRequestItem extends vscode.TreeItem { // Make sure to EXPORT if needed by command handler type check
    constructor(
        public readonly prInfo: PullRequestInfo,
        // Usually PR items aren't expandable in this view
        public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        super(`#${prInfo.number}: ${prInfo.title}`, collapsibleState);

        this.description = `by ${prInfo.author}`;
        this.tooltip = `${prInfo.title}\nAuthor: ${prInfo.author}\nClick to view details`;

        // Command to execute when the item itself is clicked (opens webview)
        this.command = {
            command: 'yourExtension.viewPullRequest', // Command defined in package.json
            title: 'View Pull Request Details',
            arguments: [this.prInfo] // Pass PR info to the command handler
        };

        // **NEW: Set context value for menu contributions**
        this.contextValue = 'pullRequestItem';

        // Optional: Icon based on PR state (open, merged, closed)
        this.iconPath = new vscode.ThemeIcon('git-pull-request');
    }
}