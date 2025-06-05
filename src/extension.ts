import * as vscode from 'vscode';
import { getGitHubSession } from './auth';
import { PrDataProvider, PullRequestItem, PullRequestInfo } from './prDataProvider'; // Ensure PullRequestInfo is exported/imported
import type { Endpoints } from "@octokit/types";
// import type { PullRequestInfo } from './prDataProvider'; // No longer needed if exported above
import { CreatePrViewProvider } from './createPrViewProvider';
import * as AnalyzeViewManager from './analyzeViewManager';
import { isGitRepositoryAvailable, getGitApi } from './gitUtils';
import * as PrDescription from './prDescriptionProvider';
// <<<< ADD Import for the new provider function >>>>
import { createOrShowReviewResultPanel } from './reviewResultViewProvider';

// Removed import for ReviewLocalRepoViewProvider

// Type Definitions (can likely be removed if fully defined in types.ts)
type IssueComment = Endpoints["GET /repos/{owner}/{repo}/issues/{issue_number}/comments"]["response"]["data"][0];
type ReviewComment = Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}/comments"]["response"]["data"][0];
type Review = Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews"]["response"]["data"][0];
type CommitListItem = Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}/commits"]["response"]["data"][0];
type ChangedFileFromApi = Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}/files"]["response"]["data"][0];
interface TimelineItemBase { timestamp: Date; }
interface ReviewTimelineItem extends TimelineItemBase { type: 'review'; data: Review & { associated_comments?: ReviewComment[] }; }
interface ReviewCommentTimelineItem extends TimelineItemBase { type: 'review_comment'; data: ReviewComment; }
interface IssueCommentTimelineItem extends TimelineItemBase { type: 'issue_comment'; data: IssueComment; }
interface CommitTimelineItem extends TimelineItemBase { type: 'commit'; data: CommitListItem; }
type TimelineItem = ReviewTimelineItem | ReviewCommentTimelineItem | IssueCommentTimelineItem | CommitTimelineItem;
export type { TimelineItem }; // Keep export if other files use it directly

let prDataProvider: PrDataProvider | undefined;
let createPrViewProviderInstance: CreatePrViewProvider | undefined;

// =================================
// EXTENSION ACTIVATION FUNCTION
// =================================
export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "github-pr-handler" is now active!');

    // Register Tree Data Provider
    prDataProvider = new PrDataProvider();
    context.subscriptions.push(vscode.window.registerTreeDataProvider('yourPrViewId', prDataProvider));

    // Register Create PR View Provider
    createPrViewProviderInstance = new CreatePrViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(CreatePrViewProvider.viewType, createPrViewProviderInstance)
    );

    // Register Commands
    context.subscriptions.push(vscode.commands.registerCommand('yourExtension.refreshPrView', () => {
        prDataProvider?.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('yourExtension.showCreatePullRequestView', async () => {
        await vscode.commands.executeCommand('setContext', 'yourExtension:createPrViewVisible', true);
        await vscode.commands.executeCommand('yourCreatePrViewId.focus');
        setTimeout(() => {
            createPrViewProviderInstance?.prepareAndSendData();
        }, 150);
    }));

    context.subscriptions.push(vscode.commands.registerCommand(
        'yourExtension.viewPullRequest',
        (itemOrPrInfo: PullRequestItem | PullRequestInfo, isNewlyCreated?: boolean) => {
            const prInfo = (itemOrPrInfo instanceof PullRequestItem) ? itemOrPrInfo.prInfo : itemOrPrInfo;
            PrDescription.createOrShowPrDetailWebview(context, prInfo, isNewlyCreated);
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'yourExtension.viewSpecificFileDiff',
        async (prInfo: PullRequestInfo, fileData: ChangedFileFromApi) => {
            if (prInfo && fileData) {
                await PrDescription.fetchAndShowDiffForFile(context, prInfo, fileData);
            } else {
                console.error("viewSpecificFileDiff called with invalid arguments:", prInfo, fileData);
                vscode.window.showErrorMessage("Could not get file information to show diff.");
            }
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand('yourExtension.analyzeRepository', async () => {
        console.log("Analyze Repository command triggered!");
        const gitAvailable = await isGitRepositoryAvailable();
        if (!gitAvailable) {
            vscode.window.showWarningMessage("Cannot analyze: No active Git repository found in the workspace.");
            return;
        }
        await AnalyzeViewManager.createOrShowAnalyzerWebview(context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('yourExtension.signIn', async () => {
        const session = await getGitHubSession();
        if (session && prDataProvider) {
            await prDataProvider.initialize();
            createPrViewProviderInstance?.prepareAndSendData();
        }
    }));

    vscode.commands.executeCommand('setContext', 'yourExtension:createPrViewVisible', false);

    console.log("Extension commands and providers registered.");
}

// Keep createTempFile function
let tempFiles: vscode.Uri[] = [];
export async function createTempFile(context: vscode.ExtensionContext, fileName: string, content: string): Promise<vscode.Uri> {
    // Ensure filename is safe for filesystem
    const safeFileName = fileName
        .replace(/[^a-z0-9_.-]/gi, '_') // Replace unsafe characters with underscore
        .replace(/_+/g, '_'); // Collapse multiple underscores

    try {
        // Check if directory exists, create if not
        try {
             await vscode.workspace.fs.stat(context.globalStorageUri);
        } catch {
             console.log(`Creating global storage directory: ${context.globalStorageUri.fsPath}`);
             await vscode.workspace.fs.createDirectory(context.globalStorageUri);
        }

        const uri = vscode.Uri.joinPath(context.globalStorageUri, safeFileName);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));

        if (!tempFiles.some(existingUri => existingUri.toString() === uri.toString())) {
            tempFiles.push(uri);
        }
        console.log(`Created temp file: ${uri.fsPath}`);
        return uri;
    } catch (e) {
         console.error(`Error creating temp file ${safeFileName}:`, e);
         throw e; // Re-throw error after logging
    }
}

// =================================
// EXTENSION DEACTIVATION
// =================================
export function deactivate() {
    Promise.allSettled(
        tempFiles.map(uri => {
            console.log(`Attempting to delete temp file: ${uri.fsPath}`);
            return Promise.resolve(vscode.workspace.fs.delete(uri, { useTrash: false })).catch(e => { // Added useTrash: false
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