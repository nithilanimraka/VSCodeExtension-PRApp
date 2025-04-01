import * as vscode from 'vscode';
import { Octokit } from '@octokit/rest';
import { PrTreeDataProvider } from './PrTreeDataProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('Extension "github-pr-handler" is now active!');
    
    const config = vscode.workspace.getConfiguration('githubPRs');
    const accessToken = config.get<string>('accessToken');

    if (!accessToken) {
        vscode.window.showErrorMessage('GitHub access token not configured');
        return;
    }

    const octokit = new Octokit({ 
        auth: accessToken 
    });

    const prTreeDataProvider = new PrTreeDataProvider(octokit);

    // Register the tree view
    const treeView = vscode.window.createTreeView('githubPRs', {
        treeDataProvider: prTreeDataProvider
    });
    context.subscriptions.push(treeView);

    // Register the command
    const disposable = vscode.commands.registerCommand('github-prs.loadPullRequests', () => {
        console.log('Load GitHub PRs command executed');
        vscode.window.showInformationMessage('Attempting to load PRs...'); // Add visual feedback
        try {
            prTreeDataProvider.refresh();
            console.log('Refresh called successfully');
        } catch (error) {
            console.error('Error refreshing PRs:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Error refreshing PRs: ${errorMessage}`);
        }
    });
    
    // Add this near the end of your activate function
    context.subscriptions.push(
        vscode.commands.registerCommand('github-pr-handler.testCommand', () => {
            vscode.window.showInformationMessage('Test command executed successfully!');
        })
    );

    // Initial load of PRs
    prTreeDataProvider.refresh();
}

export function deactivate() {}