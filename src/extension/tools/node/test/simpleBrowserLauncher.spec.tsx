/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { makeTestTypingsInstaller } from '../../../test/node/typingsInstaller';
import { IToolsService } from '../../common/toolsService';
import { SimpleBrowserLauncherTool } from '../simpleBrowserLauncher';
import { TestToolsService } from './testToolsService';
import { mock, mockService } from '../../../../test/node/mock';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { ITerminalService } from '../../../../platform/terminal/common/terminalService';
import { IRunCommandExecutionService } from '../../../../platform/commands/common/runCommandExecutionService';
import { URI } from '../../../../util/vs/base/common/uri';
import * as vscode from 'vscode';

suite('SimpleBrowserLauncherTool', () => {
    let testToolsService: TestToolsService;
    let fileSystemService: mock<IFileSystemService>;
    let workspaceService: mock<IWorkspaceService>;
    let terminalService: mock<ITerminalService>;
    let commandService: mock<IRunCommandExecutionService>;
    let instantiationService: IInstantiationService;

    const typingsInstaller = makeTestTypingsInstaller();
    setup(async () => {
        const services = new Map<any, any>();
        fileSystemService = mockService(IFileSystemService);
        workspaceService = mockService(IWorkspaceService);
        terminalService = mockService(ITerminalService);
        commandService = mockService(IRunCommandExecutionService);

        services.set(IFileSystemService, fileSystemService.object);
        services.set(IWorkspaceService, workspaceService.object);
        services.set(ITerminalService, terminalService.object);
        services.set(IRunCommandExecutionService, commandService.object);

        testToolsService = new TestToolsService(new Set());
        services.set(IToolsService, testToolsService);
        instantiationService = typingsInstaller.install(services);
    });

    const packageManagers = ['npm', 'yarn', 'pnpm', 'bun'];
    for (const pm of packageManagers) {
        test(`should use ${pm} when ${pm}.lock file is present`, async () => {
            // Arrange
            const tool = instantiationService.createInstance(SimpleBrowserLauncherTool);
            testToolsService.registerTool(tool);

            const workspaceFolder = { uri: URI.file(`/test/workspace-${pm}`) };
            workspaceService.setup(s => s.getWorkspaceFolders()).returns([workspaceFolder] as any);
            fileSystemService.setup(s => s.exists(mock.any())).returns(Promise.resolve(false));
            fileSystemService.setup(s => s.exists(URI.joinPath(workspaceFolder.uri, 'package.json'))).returns(Promise.resolve(true));

            let lockFile: URI;
            let installCommand: string;
            let runCommand: string;

            switch (pm) {
                case 'yarn':
                    lockFile = URI.joinPath(workspaceFolder.uri, 'yarn.lock');
                    installCommand = 'yarn';
                    runCommand = 'yarn dev';
                    break;
                case 'pnpm':
                    lockFile = URI.joinPath(workspaceFolder.uri, 'pnpm-lock.yaml');
                    installCommand = 'pnpm install';
                    runCommand = 'pnpm dev';
                    break;
                case 'bun':
                    lockFile = URI.joinPath(workspaceFolder.uri, 'bun.lockb');
                    installCommand = 'bun install';
                    runCommand = 'bun dev';
                    break;
                default: // npm
                    lockFile = URI.joinPath(workspaceFolder.uri, 'package-lock.json');
                    installCommand = 'npm install';
                    runCommand = 'npm run dev';
                    break;
            }

            fileSystemService.setup(s => s.exists(lockFile)).returns(Promise.resolve(true));
            const packageJsonContent = JSON.stringify({ scripts: { dev: 'vite' } });
            fileSystemService.setup(s => s.readFile(URI.joinPath(workspaceFolder.uri, 'package.json'))).returns(Promise.resolve(Buffer.from(packageJsonContent)));

            const installTerminal = mock<vscode.Terminal>();
            const devTerminal = mock<vscode.Terminal>();
            terminalService.setup(s => s.createTerminal(mock.match(o => o.name === 'SimpleBrowserLauncher'))).returns(installTerminal.object);
            terminalService.setup(s => s.createTerminal(mock.match(o => o.name === 'Dev Server'))).returns(devTerminal.object);

            const url = 'http://localhost:3000';
            const writeEmitter = new vscode.EventEmitter<vscode.TerminalDataWriteEvent>();
            terminalService.setup(s => s.onDidWriteTerminalData).returns(writeEmitter.event);

            // Act
            const promise = tool.invoke({} as any, new vscode.CancellationTokenSource().token);

            // Assert
            writeEmitter.fire({ terminal: devTerminal.object, data: `> vite\n\n  VITE v4.3.9  ready in 530 ms\n\n  ➜  Local:   ${url}\n` });

            const result = await promise;
            assert.strictEqual(result.items[0].value, `Simple Browser opened at ${url}`);

            commandService.verify(s => s.executeCommand('simpleBrowser.show', url), 1);
            installTerminal.verify(s => s.sendText(installCommand), 1);
            devTerminal.verify(s => s.sendText(runCommand), 1);
        });
    }
});
