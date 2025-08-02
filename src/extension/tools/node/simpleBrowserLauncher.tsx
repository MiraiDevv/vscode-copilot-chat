/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { IRunCommandExecutionService } from '../../../platform/commands/common/runCommandExecutionService';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { ToolName } from '../common/toolNames';
import { ITerminalService } from '../../../platform/terminal/common/terminalService';
import { URI } from '../../../util/vs/base/common/uri';

export interface ISimpleBrowserLauncherParams {
    // For now, no parameters are needed from the user.
    // The tool will automatically detect the project and run it.
}

export class SimpleBrowserLauncherTool implements ICopilotTool<ISimpleBrowserLauncherParams> {
    public static readonly toolName = ToolName.SimpleBrowserLauncher; // This will be a new tool name

    constructor(
        @IFileSystemService private readonly fileSystemService: IFileSystemService,
        @IRunCommandExecutionService private readonly commandService: IRunCommandExecutionService,
        @IWorkspaceService private readonly workspaceService: IWorkspaceService,
        @ILogService private readonly logService: ILogService,
        @ITerminalService private readonly terminalService: ITerminalService,
    ) { }

    async invoke(options: vscode.LanguageModelToolInvocationOptions<ISimpleBrowserLauncherParams>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
        this.logService.info('SimpleBrowserLauncherTool invoked');

        const workspaceFolders = this.workspaceService.getWorkspaceFolders();
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return { items: [new vscode.LanguageModelTextPart('No workspace folder is open.')] };
        }
        const workspaceRoot = workspaceFolders[0].uri;

        try {
            const packageManager = await this.getPackageManager(workspaceRoot);

            // Check for node_modules
            const nodeModulesPath = URI.joinPath(workspaceRoot, 'node_modules');
            const nodeModulesExists = await this.fileSystemService.exists(nodeModulesPath);

            if (!nodeModulesExists) {
                await this.runCommandInTerminal(packageManager.installCommand, workspaceRoot);
            }

            // Read package.json
            const packageJsonPath = URI.joinPath(workspaceRoot, 'package.json');
            const packageJsonExists = await this.fileSystemService.exists(packageJsonPath);
            if (!packageJsonExists) {
                return { items: [new vscode.LanguageModelTextPart('No package.json found in the workspace.')] };
            }

            const packageJsonContent = await this.fileSystemService.readFile(packageJsonPath);
            const packageJson = JSON.parse(new TextDecoder().decode(packageJsonContent));

            // Determine dev script
            let devScript: string;
            if (packageJson.scripts?.dev) {
                devScript = packageManager.runCommand;
            } else if (packageJson.scripts?.start) {
                devScript = packageManager.name === 'npm' ? 'npm run start' : `${packageManager.name} start`;
            } else {
                return { items: [new vscode.LanguageModelTextPart('No "dev" or "start" script found in package.json.')] };
            }

            // Run dev script and capture URL
            const url = await this.runDevScriptAndCaptureUrl(devScript, workspaceRoot);

            if (url) {
                // Launch Simple Browser
                await this.commandService.executeCommand('simpleBrowser.show', url);
                return { items: [new vscode.LanguageModelTextPart(`Simple Browser opened at ${url}`)] };
            } else {
                return { items: [new vscode.LanguageModelTextPart('Could not determine the server URL.')] };
            }

        } catch (error) {
            this.logService.error(error);
            return { items: [new vscode.LanguageModelTextPart(`An error occurred: ${error.message}`)] };
        }
    }

    private async runCommandInTerminal(command: string, cwd: vscode.Uri): Promise<void> {
        return new Promise(resolve => {
            const terminal = this.terminalService.createTerminal({ name: 'SimpleBrowserLauncher', cwd });
            terminal.sendText(command);
            const disposable = this.terminalService.onDidCloseTerminal(t => {
                if (t === terminal) {
                    disposable.dispose();
                    resolve();
                }
            });
            // This is a simplification. In a real scenario, we'd need a more robust
            // way to detect command completion. For `npm install`, we can check for
            // the command prompt to reappear, but that's complex. For now, we'll
            // just assume it completes and the terminal closes, or we can add a timeout.
            // For the sake of this exercise, we'll just resolve when the terminal is closed.
        });
    }

    private async runDevScriptAndCaptureUrl(script: string, cwd: vscode.Uri): Promise<string | null> {
        return new Promise((resolve, reject) => {
            const terminal = this.terminalService.createTerminal({ name: 'Dev Server', cwd });
            terminal.sendText(script);

            const disposable = this.terminalService.onDidWriteTerminalData(e => {
                if (e.terminal === terminal) {
                    const urlRegex = /(https?:\/\/[^\s]+)/;
                    const match = e.data.match(urlRegex);
                    if (match) {
                        disposable.dispose();
                        resolve(match[0]);
                    }
                }
            });

            // Timeout to avoid waiting forever
            setTimeout(() => {
                disposable.dispose();
                reject(new Error('Timeout waiting for server URL.'));
            }, 60000); // 1 minute
        });
    }

    private async getPackageManager(workspaceRoot: vscode.Uri): Promise<{ name: string, installCommand: string, runCommand: string }> {
        const yarnLockPath = URI.joinPath(workspaceRoot, 'yarn.lock');
        const pnpmLockPath = URI.joinPath(workspaceRoot, 'pnpm-lock.yaml');
        const bunLockPath = URI.joinPath(workspaceRoot, 'bun.lockb');

        if (await this.fileSystemService.exists(bunLockPath)) {
            return { name: 'bun', installCommand: 'bun install', runCommand: 'bun dev' };
        }
        if (await this.fileSystemService.exists(pnpmLockPath)) {
            return { name: 'pnpm', installCommand: 'pnpm install', runCommand: 'pnpm dev' };
        }
        if (await this.fileSystemService.exists(yarnLockPath)) {
            return { name: 'yarn', installCommand: 'yarn', runCommand: 'yarn dev' };
        }
        return { name: 'npm', installCommand: 'npm install', runCommand: 'npm run dev' };
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ISimpleBrowserLauncherParams>, token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation> {
        const workspaceFolders = this.workspaceService.getWorkspaceFolders();
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return {
                invocationMessage: new vscode.MarkdownString(l10n.t`No workspace folder is open.`),
                pastTenseMessage: new vscode.MarkdownString(l10n.t`No workspace folder was open.`),
            };
        }
        const workspaceRoot = workspaceFolders[0].uri;
        const packageManager = await this.getPackageManager(workspaceRoot);

        return {
            invocationMessage: new vscode.MarkdownString(l10n.t`Preparing to launch Simple Browser...`),
            pastTenseMessage: new vscode.MarkdownString(l10n.t`Prepared to launch Simple Browser.`),
            confirmationMessages: {
                title: l10n.t`Run Simple Browser Launcher?`,
                message: new vscode.MarkdownString(l10n.t`This will run '{0}' and start a development server if necessary. Do you want to continue?`, packageManager.installCommand)
            }
        };
    }
}

ToolRegistry.registerTool(SimpleBrowserLauncherTool);
