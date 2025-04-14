import * as vscode from 'vscode';
import { getGitHubSession, getOctokit } from './auth';
import { PrDataProvider, PullRequestItem } from './prDataProvider';
import { Octokit } from '@octokit/rest'; 
import type { Endpoints } from "@octokit/types"; 
import type { PullRequestInfo } from './prDataProvider';
import { CreatePrViewProvider } from './createPrViewProvider'; 
import { getNonce, escapeHtml } from './utils'; 

import * as PrDescription from './prDescriptionProvider'; 

// Type Definitions for GitHub API Responses 
type IssueComment = Endpoints["GET /repos/{owner}/{repo}/issues/{issue_number}/comments"]["response"]["data"][0];
type ReviewComment = Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}/comments"]["response"]["data"][0];
type Review = Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews"]["response"]["data"][0];
type CommitListItem = Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}/commits"]["response"]["data"][0];
type ChangedFileFromApi = Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}/files"]["response"]["data"][0];

type FromWebviewMessage =
    | { command: 'webviewReady' }
    | { command: 'showError'; text: string }
    | { command: 'alert'; text: string }
    | { command: 'mergePr'; data: { merge_method: 'merge' | 'squash' | 'rebase' } }
    | { command: 'addComment'; text: string }
    | { command: 'closePr' }
    | { command: 'refreshThisPr' };

type MergeStatusUpdateData = {
    mergeable: boolean | null;
    mergeable_state: string;
};

interface PrDetails {
    timeline: TimelineItem[];
    mergeable_state: string; 
    mergeable: boolean | null;
    // Fields for the header display
    state: 'open' | 'closed';
    merged: boolean;
    authorLogin: string;
    authorAvatarUrl?: string | null;
    baseLabel: string; 
    headLabel: string; 
    body: string | null;
    createdAt: string; 
}

// Timeline Item Structure 
interface TimelineItemBase {
    timestamp: Date;
}
interface ReviewTimelineItem extends TimelineItemBase {
    type: 'review';
    // Associated comments directly to the data payload 
    data: Review & { associated_comments?: ReviewComment[] };
}
interface ReviewCommentTimelineItem extends TimelineItemBase {
    type: 'review_comment';
    data: ReviewComment;
}
interface IssueCommentTimelineItem extends TimelineItemBase {
    type: 'issue_comment';
    data: IssueComment;
}
interface CommitTimelineItem extends TimelineItemBase {
    type: 'commit';
    data: CommitListItem;
}

interface ChangedFile {
    path: string;
    status: 'A' | 'M' | 'D' | 'R' | 'C' | '?';
}

type TimelineItem = ReviewTimelineItem | ReviewCommentTimelineItem | IssueCommentTimelineItem | CommitTimelineItem;

export type { TimelineItem }; // Export the main timeline type


let prDataProvider: PrDataProvider | undefined;

interface ActivePrWebview {
    panel: vscode.WebviewPanel;
    prInfo: PullRequestInfo;
    lastCommentCheckTime?: Date; 
    currentTimeline?: TimelineItem[]; 
}
const activePrDetailPanels = new Map<number, ActivePrWebview>(); // Keyed by PR number
let pollingIntervalId: NodeJS.Timeout | undefined = undefined;
const POLLING_INTERVAL_MS = 30000; // Poll every 30 seconds


// =================================
// EXTENSION ACTIVATION FUNCTION
// =================================
export function activate(context: vscode.ExtensionContext) {

    console.log('Congratulations, your extension "your-pr-extension" is now active!');

    // Register Tree Data Provider 
    prDataProvider = new PrDataProvider();
    context.subscriptions.push(vscode.window.registerTreeDataProvider('yourPrViewId', prDataProvider));

    // Register Create PR View 
    // Store the provider instance so the command can call it
    const createPrViewProvider = new CreatePrViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(CreatePrViewProvider.viewType, createPrViewProvider)
    );

    // Register Commands 

    // Refresh Command
    context.subscriptions.push(vscode.commands.registerCommand('yourExtension.refreshPrView', () => {
        prDataProvider?.refresh();
        for (const activeWebview of activePrDetailPanels.values()) {
             PrDescription.updateWebviewContent(context, activeWebview.panel.webview, activeWebview.prInfo);
        }
    }));

    // Show Create Pull Request View 
    context.subscriptions.push(vscode.commands.registerCommand('yourExtension.showCreatePullRequestView', async () => {
        await vscode.commands.executeCommand('setContext', 'yourExtension:createPrViewVisible', true);
        // Explicitly focus the view 
        await vscode.commands.executeCommand('yourCreatePrViewId.focus');
        // Tell the provider to load its data
        // Small delay might be needed after focus before provider is fully ready
        setTimeout(() => {
            createPrViewProvider.prepareAndSendData();
        }, 100); // Short delay
   }));

    // Command for clicking a PR item in the Tree View (yourPrViewId)
    // Update the command registration for viewPullRequest
    context.subscriptions.push(vscode.commands.registerCommand(
        'yourExtension.viewPullRequest',
        // Add the optional boolean flag parameter
        (itemOrPrInfo: PullRequestItem | PullRequestInfo, isNewlyCreated?: boolean) => {
            const prInfo = (itemOrPrInfo instanceof PullRequestItem) ? itemOrPrInfo.prInfo : itemOrPrInfo;
            // Pass the flag along to the function that opens the webview
            PrDescription.createOrShowPrDetailWebview(context, prInfo, isNewlyCreated);
        }
    ));


    context.subscriptions.push(vscode.commands.registerCommand(
        'yourExtension.viewSpecificFileDiff',
        // Command handler receives arguments passed from ChangedFileItem's command
        async (prInfo: PullRequestInfo, fileData: ChangedFileFromApi) => {
            if (prInfo && fileData) {
                 // Call the modified diff function with the specific file data
                 await PrDescription.fetchAndShowDiffForFile(context, prInfo, fileData);
            } else {
                 console.error("viewSpecificFileDiff called with invalid arguments:", prInfo, fileData);
                 vscode.window.showErrorMessage("Could not get file information to show diff.");
            }
        }
    ));

    // Sign In Command
    context.subscriptions.push(vscode.commands.registerCommand('yourExtension.signIn', async () => {
        const session = await getGitHubSession();
        if (session && prDataProvider) {
            await prDataProvider.initialize();
            prDataProvider.refresh();
        }
    }));

    // Start with the create view hidden
    vscode.commands.executeCommand('setContext', 'yourExtension:createPrViewVisible', false);
}


let tempFiles: vscode.Uri[] = []; // Keep temp file tracking
export async function createTempFile(context: vscode.ExtensionContext, fileName: string, content: string): Promise<vscode.Uri> {
    // Use extension's global storage path for temp files
    const safeFileName = fileName.replace(/[\\/?*:|"<>]/g, '_'); // More robust sanitization
    // Ensure global storage directory exists (VS Code should handle this, but belt-and-suspenders)
    try { 
        await vscode.workspace.fs.createDirectory(context.globalStorageUri); 
    } catch(e) { 
        vscode.window.showErrorMessage(`Failed to create global storage directory: ${e}`); 
    }
    // Create the file URI
    const uri = vscode.Uri.joinPath(context.globalStorageUri, safeFileName);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    if (!tempFiles.some(existingUri => existingUri.toString() === uri.toString())) {
         tempFiles.push(uri); // Track for cleanup, avoid duplicates
    }
    return uri;
}



// =================================
// EXTENSION DEACTIVATION
// =================================
export function deactivate() {
    // Stop polling
    if (pollingIntervalId) {
        clearInterval(pollingIntervalId);
        pollingIntervalId = undefined;
         console.log("Polling stopped on deactivation.");
    }
    activePrDetailPanels.clear();

    // Clean up temporary diff files
    // Use Promise.allSettled to attempt deleting all even if some fail
    Promise.allSettled(
        tempFiles.map(uri => {
            console.log(`Attempting to delete temp file: ${uri.fsPath}`);
            return Promise.resolve(vscode.workspace.fs.delete(uri)).catch(e => {
                // Catch deletion error for individual files but don't stop others
                console.warn(`Failed to delete temp file ${uri.fsPath}:`, e);
            });
        })
    )
    .then((results) => {
        const deletedCount = results.filter(r => r.status === 'fulfilled').length;
        const failedCount = results.filter(r => r.status === 'rejected').length;
        console.log(`Cleaned up ${deletedCount} temporary diff files. ${failedCount > 0 ? `${failedCount} failed.` : ''}`);
    });
    tempFiles = []; // Clear the array

    console.log("Your PR extension deactivated.");
}



