import * as vscode from 'vscode';
import { getOctokit } from './auth'; 
import { Octokit } from '@octokit/rest'; 
import type { Endpoints } from "@octokit/types";

// Type for file objects from listFiles endpoint
type ChangedFileFromApi = Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}/files"]["response"]["data"][0];

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

        if (element instanceof PullRequestItem) { // <<< ADD THIS BLOCK
            // Return children for an expanded PullRequestItem

            if (!element.filesFetched) {
                // Fetch files if not already fetched
                try {
                    const response = await this.octokit.pulls.listFiles({
                        owner: element.prInfo.repoOwner,
                        repo: element.prInfo.repoName,
                        pull_number: element.prInfo.number,
                        per_page: 300 // Adjust if needed
                    });
                    element.changedFiles = response.data;
                    element.filesFetched = true;
                } catch (error) {
                     console.error(`Failed to fetch files for PR #${element.prInfo.number}:`, error);
                     element.filesFetched = true; // Mark as fetched to avoid retrying immediately
                     element.changedFiles = undefined; // Ensure no files are shown
                     // Return an error item?
                     return [new vscode.TreeItem("Error fetching changed files")];
                }
            }
    
            // Create child items if files were fetched successfully
            const children: vscode.TreeItem[] = [new DescriptionItem(element.prInfo)]; // Always add Description first
            if (element.changedFiles && element.changedFiles.length > 0) {
                element.changedFiles.forEach(file => {
                    children.push(new ChangedFileItem(element.prInfo, file));
                });
            } else if (element.filesFetched) {
                 // If fetched but no files found
                 children.push(new vscode.TreeItem("No changed files found", vscode.TreeItemCollapsibleState.None));
            }
    
            return children;
    
        } else if (element instanceof CategoryItem) { 
            // Existing logic for categories
            if (element.label) {
                 return this.getPullRequestsForCategory(element.label as string);
            }
            return [];
        } else if (!element) {
            // Existing logic for root level (categories)
             const categories: vscode.TreeItem[] = [ 
                new CategoryItem("Waiting For My Review", vscode.TreeItemCollapsibleState.Collapsed),
                new CategoryItem("Assigned To Me", vscode.TreeItemCollapsibleState.Collapsed),
                new CategoryItem("Created By Me", vscode.TreeItemCollapsibleState.Collapsed),
                new CategoryItem("All Open", vscode.TreeItemCollapsibleState.Collapsed)
                // Add "Local Pull Request Branches" if you implement that logic
            ];
            return Promise.resolve(categories);

        } else {
            // Should not happen if hierarchy is only Category -> PR -> (Desc + Files)
             return [];
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
                 return new PullRequestItem(prInfo);
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
    public changedFiles?: ChangedFileFromApi[]; // To store fetched files
    public filesFetched: boolean = false; // Flag to check if fetched

    constructor(
        public readonly prInfo: PullRequestInfo,
        
        // Collapsible state can be passed in, default to collapsed
        // This allows for nested PRs or categories if needed
        public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed // Default to collapsed
    ) {
        super(`#${prInfo.number}: ${prInfo.title}`, collapsibleState);

        this.description = `by ${prInfo.author}`;
        this.tooltip = `${prInfo.title}\nAuthor: ${prInfo.author}\nClick to expand`; 
        this.contextValue = 'pullRequestItem'; // Used for context menu contributions
        this.iconPath = new vscode.ThemeIcon('git-pull-request'); 
    }
}


class DescriptionItem extends vscode.TreeItem {
    constructor(prInfo: PullRequestInfo) {
        super("Description", vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('book'); // Or 'note'
        this.command = {
            command: 'yourExtension.viewPullRequest', // Command to open detail webview
            title: 'View Pull Request Details',
            arguments: [prInfo] // Pass PR info
        };
        this.contextValue = 'descriptionItem';
    }
}

class ChangedFileItem extends vscode.TreeItem {
    constructor(
        public readonly prInfo: PullRequestInfo,
        public readonly fileData: ChangedFileFromApi // Store the specific file data
    ) {
        // Use filename for the label
        super(fileData.filename, vscode.TreeItemCollapsibleState.None);

        // Use status for description
        this.description = this.mapStatus(fileData.status);

        // Add tooltip showing full path and status
        this.tooltip = `${fileData.filename}\nStatus: ${fileData.status}`;

        // ICON COLOR LOGIC
        const status = fileData.status;
        let iconColorId: string | undefined;

        // Map file status to standard Git decoration theme colors
        switch (status) {
            case 'added':
                iconColorId = 'gitDecoration.addedResourceForeground'; // Green
                break;
            case 'modified':
            case 'changed': // Treat file type changes like modifications
                iconColorId = 'gitDecoration.modifiedResourceForeground'; // Blue/Yellow (theme dependent)
                break;
             case 'renamed': // Renamed often shown as modified in lists
                 iconColorId = 'gitDecoration.renamedResourceForeground'; // Often blue
                 break;
            case 'removed':
                iconColorId = 'gitDecoration.deletedResourceForeground'; // Red/Gray (theme dependent)
                break;
            case 'copied': // Copied often shown as added
                 iconColorId = 'gitDecoration.addedResourceForeground'; // Green
                 break;
            // 'untracked' or 'ignored' shouldn't typically appear in PR files
            // case 'untracked': iconColorId = 'gitDecoration.untrackedResourceForeground'; break;
            // case 'ignored': iconColorId = 'gitDecoration.ignoredResourceForeground'; break;
            default:
                iconColorId = undefined; // Use default icon color
        }

        // Get the base file icon ID (string) using a helper
        const baseIconId = this.getFileIconId(fileData.filename);

        // Create ThemeIcon with base icon ID and optional ThemeColor
        this.iconPath = new vscode.ThemeIcon(
            baseIconId, // The ID of the icon (e.g., 'file-code')
            iconColorId ? new vscode.ThemeColor(iconColorId) : undefined // Apply color if found
        );

        this.command = {
            command: 'yourExtension.viewSpecificFileDiff',
            title: 'View File Changes',
            arguments: [prInfo, fileData]
        };
        this.contextValue = 'changedFileItem';
    }

    // Helper to map API status to single characters (optional)
    private mapStatus(status: string): string {
         switch (status) {
            case 'added': return 'A';
            case 'removed': return 'D';
            case 'modified': return 'M';
            case 'renamed': return 'R';
            case 'copied': return 'C'; // Less common
            case 'changed': return 'M'; // Treat 'changed' (type change) as 'modified'
            case 'unchanged': return ''; // Should not appear in listFiles really
            default: return '?';
        }
    }

    // Helper to get file icon (adapt from createPrMain.ts or simplify)
    private getFileIconId(filename: string): string {
        const lowerFilename = filename.toLowerCase();
        if (lowerFilename.endsWith('.py')) return 'file-code';
        if (lowerFilename.endsWith('.js')) return 'file-code';
        if (lowerFilename.endsWith('.ts')) return 'file-code';
        if (lowerFilename.endsWith('.java')) return 'file-code';
        if (lowerFilename.endsWith('.cs')) return 'file-code';
        if (lowerFilename.endsWith('.html')) return 'file-code';
        if (lowerFilename.endsWith('.css')) return 'file-code';
        if (lowerFilename.endsWith('.json')) return 'json';
        if (lowerFilename.endsWith('.md')) return 'markdown';
        if (lowerFilename.endsWith('.txt')) return 'file-text';
        if (lowerFilename.includes('requirements')) return 'checklist';
        if (lowerFilename.includes('dockerfile')) return 'docker';
        if (lowerFilename.includes('config') || lowerFilename.endsWith('.yml') || lowerFilename.endsWith('.yaml')) return 'settings-gear';
        if (lowerFilename.endsWith('.git') || lowerFilename.includes('gitignore') || lowerFilename.includes('gitattributes')) return 'git-commit';
        if (lowerFilename.endsWith('.png') || lowerFilename.endsWith('.jpg') || lowerFilename.endsWith('.jpeg') || lowerFilename.endsWith('.gif') || lowerFilename.endsWith('.svg')) return 'file-media';
        return 'file'; // Default file icon ID
    }
}