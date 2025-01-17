import * as vscode from 'vscode';
import { ExtensionConstants, LanguageConstants, TestResults } from '../constants';
import RelatedErrorView from './relatedErrorView';
import { searchDirectory } from '../miscTools';
import { PCommands } from '../commands';
import * as child_process from 'child_process';
import { SpawnSyncReturns } from 'child_process';
const fs = require('fs');

export default class TestingEditor {
    static instance: TestingEditor;
    static controller = vscode.tests.createTestController('pTestController', 'P Tests');
    static testRe = /^\s*test/g;
  

    public static async createAndRegister(context: vscode.ExtensionContext) : Promise<TestingEditor> {
        context.subscriptions.push(TestingEditor.controller);
        context.subscriptions.push(
            /*
            CHANGE Text Document => Update the parsing of a Test File
            DELETE or CREATE a Text Document => Update parsing of Test File

            */
            vscode.workspace.onDidChangeTextDocument(e => updateNodeFromDocument(e.document)),
            vscode.workspace.onWillDeleteFiles(e => e.files.forEach(async fileUri => {
                updateNodeFromDocument(await vscode.workspace.openTextDocument(fileUri))
            })
            ),
            vscode.workspace.onDidCreateFiles(e => e.files.forEach(async fileUri => {
                updateNodeFromDocument(await vscode.workspace.openTextDocument(fileUri))
            })) 
        )     

        //Looks through the entire test folder to discover where is the test file and where the tests are.
        var files = await searchDirectory("**/PTst/Test*.p");
        if (files != null) {
            for (var i = 0; i<files.length; i++) {
                var x = files.at(i)
                if (x !== undefined) {
                    updateNodeFromDocument(await vscode.workspace.openTextDocument(x));
            
                }
            }
        }
        return TestingEditor.instance;
    }

}

function updateFromContents(controller: vscode.TestController, content: string, uri: vscode.Uri, item: vscode.TestItem) {
    //If the document has already been parsed, remove all the current children to re-parse.
    if (item.children.size >0) {
        item.children.forEach(child => item.children.delete(child.id))
    }
    
    parsePTestFile(content, {
        onTest: (name, range) => {
            var uniqueID = range.start.line.toString() + uri;
            const tCase = controller.createTestItem(uniqueID, name, uri);
            tCase.range = range;
            item.children.add(tCase);
        }
    })

    if (item.children.size == 0) {
        controller.items.delete(item.id)
    }
    else {
        const runProfile = controller.createRunProfile(
            'Run',
            vscode.TestRunProfileKind.Run,
            (request, token) => {runHandler(request, token);}
        )
    }
}

//Parses a P test file, looking for 'Test Items'
function parsePTestFile(text: string, 
    events: {
        onTest(name: string, range: vscode.Range): void
        }) 
{
    const lines = text.split('\n');

    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
        const line = lines[lineNo];
        const test = TestingEditor.testRe.exec(line);
        if (test) {
            const range = new vscode.Range(new vscode.Position(lineNo, 0), new vscode.Position(lineNo, line.length));
            const words = line.split('test ')[1].split(/ |[^A-Za-z_]/);
            events.onTest(words[0], range);
            continue;
        }

    }
}

//Handles running a Test Run Request
async function runHandler (request: vscode.TestRunRequest, token: vscode.CancellationToken)
 {
    const run = TestingEditor.controller.createTestRun(request);
    const queue: vscode.TestItem[] = [];

    if (request.include) {
        request.include.forEach(test => queue.push(test));
        request.include.forEach(test => run.enqueued(test));
    }

    while (queue.length >0) {
        const test = queue.pop()!;
        run.started(test);

        await handlePTestCase(run, test);

        
    }
    run.end();
}

/*
Compiles the P directory.
If the Test Item is a file: run its children. Else: Run the test case.
*/
async function handlePTestCase(run: vscode.TestRun, tc: vscode.TestItem) {
    //await RelatedErrorView.refreshRelatedErrors();

    if (tc.parent == undefined) {
        tc.children.forEach(item => run.enqueued(item));
        tc.children.forEach(async item => await runPTestCase(run, item))
    }
    else {
        await runPTestCase(run, tc);
    }
}

//Always runs a SINGLE P Test Case.
async function runPTestCase(run: vscode.TestRun, tc: vscode.TestItem) {
    run.started(tc);
    var result = TestResults.Error;
    let terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal();
    if (terminal.name == PCommands.RunTask) {
        for (let i = 0; i<vscode.window.terminals.length; i++) {
          if (vscode.window.terminals.at(i)?.name != PCommands.RunTask) {
            terminal = vscode.window.terminals.at(i) ?? vscode.window.createTerminal();
            break;
          }
        }
        if (terminal.name == PCommands.RunTask) {
            terminal = vscode.window.createTerminal();
        }
      }
    //Sends P Check command through the terminal
    terminal.show();
    const outputDirectory = "PCheckerOutput/" + tc.label
    var outputFile = outputDirectory + "/check.log";
    var projectDirectory = tc.uri?.fsPath.split("PTst")[0];

    if (vscode.workspace.workspaceFolders !== undefined) {
        var contents =  await runCheckCommand(terminal, tc, outputDirectory, projectDirectory?? '');
        await checkResult(result, outputFile, run, tc, projectDirectory?? '', contents);
    }
    
    return;
}

//Check the output of the test.
async function checkResult(result: string, outputFile:string, run:vscode.TestRun, tc:vscode.TestItem, projectDirectory:string, contents:string) {
    if (contents.includes("Found 0 bugs")) {
        result= TestResults.Pass;
    }
    else if (contents.includes("found a bug")) {            
        result= TestResults.Fail;
    }
    switch (result) {
        case TestResults.Pass: {
            run.passed(tc);
            break;
        }
        case TestResults.Fail: {
            var msg =  new vscode.TestMessage("Failure after P Check Command")
            msg.location = new vscode.Location(tc.uri!, tc.range!);
            run.failed(tc, msg);
            break;
        }
        case TestResults.Error: {
            var msg =  new vscode.TestMessage("Test Errored in Running")
            run.errored(tc, msg);
        }
    }
}

//Runs p check in a child process and returns the stdout or result. 
function runCheckCommand(terminal:vscode.Terminal, tc:vscode.TestItem, outputDirectory:string, projectDirectory:string):string {
    //number of p checker iterations that are run
    const numIterations: String =  vscode.workspace.getConfiguration("p-vscode").get("iterations")?? "1000";
    //The p check command depends on if the terminal is bash or zsh.
    var command; 

    command = "cd " + projectDirectory + " && p check -tc " + tc.label + " -i " + numIterations;
    terminal.sendText(command);
    var contents:string;
    try {
        let stdOut =child_process.execSync(command, {shell: '/bin/sh'});
        return stdOut.toString();
    }
    catch (e) {
        const val: SpawnSyncReturns<Buffer> = e as SpawnSyncReturns<Buffer>;
        contents = val.stdout.toString();
        if (contents.length==0) {
            vscode.window.showErrorMessage("Test Failed: " + tc.label);
            throw e;
        }
    }
    return contents;
}


function updateNodeFromDocument(e: vscode.TextDocument) {
    const name = e.fileName.split("/");
    if (name.at(-1) ==undefined || !name.includes("PTst")) {
        return;
    }
    if (e.uri.scheme !== 'file') {
        return;
    }
    if (!e.uri.path.endsWith('.p')) {
        return;
    }
    const file = getFile(e.uri);
    updateFromContents(TestingEditor.controller, e.getText(), e.uri, file); 
}


//If the Testing File already exists, return the file. If it doesn't, add it to the TestController and then return the file. 
function getFile(uri: vscode.Uri) {
    const existing = TestingEditor.controller.items.get(uri.toString());
	if (existing) {
		return existing;
	}
    const file = TestingEditor.controller.createTestItem(uri.toString(), uri.path, uri);
    TestingEditor.controller.items.add(file);
    file.canResolveChildren = true;
    return file;
}





// export class TestFile {
//     parsePTestFile(text: string, events: {
//             onTest(name: string, range: vscode.Range): void
//             }) 
//     {
//         const lines = text.split('\n');
    
//         for (let lineNo = 0; lineNo < lines.length; lineNo++) {
//             const line = lines[lineNo];
//             const test = TestingEditor.testRe.exec(line);
//             if (test) {
//                 const range = new vscode.Range(new vscode.Position(lineNo, 0), new vscode.Position(lineNo, 0));
//                 const words = line.split('\s+');
//                 events.onTest(words[1], range);
//                 continue;
//             }
    
//         }
//     }
// }
