/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as assert from 'assert';
import Crdp from '../../crdp/crdp';

import * as testUtils from '../testUtils';
import * as ConsoleHelper from '../../src/chrome/consoleHelper';

suite('ConsoleHelper', () => {
    setup(() => {
        testUtils.setupUnhandledRejectionListener();
    });

    teardown(() => {
        testUtils.removeUnhandledRejectionListener();
    });

    /**
     * Test helper valid when the message consists only of strings that will be collapsed to one string
     */
    function doAssertForString(params: Crdp.Runtime.ConsoleAPICalledEvent, expectedText: string, expectedIsError = false): void {
        const result = ConsoleHelper.formatConsoleArguments(params);

        // Strings are collapsed to one string
        assert.equal(result.args.length, 1);
        assert.equal(result.args[0].type, 'string');

        assert.equal(result.args[0].value, expectedText);
        assert.equal(result.isError, expectedIsError);
    }

    suite('console.log()', () => {
        test('simple log', () => {
            doAssertForString(Runtime.makeLog('Hello'), 'Hello');
            doAssertForString(Runtime.makeLog('Hello', 123, 'world!'), 'Hello 123 world!');
        });

        test('basic format specifiers', () => {
            doAssertForString(Runtime.makeLog('%s, %d', 'test', 123), 'test, 123');
        });

        test('numeric format specifiers correctly', () => {
            doAssertForString(Runtime.makeLog('%d %i %f', 1.9, 324, 9.4), '1 324 9.4');
            doAssertForString(Runtime.makeLog('%d %i %f', -19, -32.5, -9.4), '-19 -33 -9.4');
            doAssertForString(Runtime.makeLog('%d %i %f', 'not', 'a', 'number'), 'NaN NaN NaN');
        });

        test('unmatched format specifiers', () => {
            doAssertForString(Runtime.makeLog('%s %s %s', 'test'), 'test %s %s');
            doAssertForString(Runtime.makeLog('%s %s end', 'test1', 'test2', 'test3'), 'test1 test2 end test3');
        });

        test('null/undefined cases', () => {
            doAssertForString(Runtime.makeLog('%s %s %s', null, undefined, 'test'), 'null undefined test');
            doAssertForString(Runtime.makeLog('test', null, undefined), 'test null undefined');
        });

        test('strips %c patterns', () => {
            doAssertForString(Runtime.makeLog('foo %cbar', 'color: red'), 'foo bar');
        });

        test('starts with non-string', () => {
            doAssertForString(Runtime.makeLog(1, 2, 3), '1 2 3');
        });

        test('string and object', () => {
            const result = ConsoleHelper.formatConsoleArguments(Runtime.makeLog('foo', '$obj', 'bar'));
            assert.equal(result.isError, false);
            assert.equal(result.args.length, 3);
            assert.equal(result.args[0].value, 'foo');
            assert.equal(result.args[1].type, 'object');
            assert.equal(result.args[2].value, 'bar');
        });

        test('formatted strings and object', () => {
            const result = ConsoleHelper.formatConsoleArguments(Runtime.makeLog('foo %d', 1, '$obj'));
            assert.equal(result.isError, false);
            assert.equal(result.args.length, 2);
            assert.equal(result.args[0].value, 'foo 1');
            assert.equal(result.args[1].type, 'object');
        });

        test('object formatted as num', () => {
            const result = ConsoleHelper.formatConsoleArguments(Runtime.makeLog('foo %d', '$obj'));
            assert.equal(result.isError, false);
            assert.equal(result.args.length, 1);
            assert.equal(result.args[0].value, 'foo NaN');
        });

        test('object formatted as string', () => {
            const result = ConsoleHelper.formatConsoleArguments(Runtime.makeLog('foo %s', '$obj'));
            assert.equal(result.isError, false);
            assert.equal(result.args.length, 1);
            assert.equal(result.args[0].value, 'foo Object');
        });
    });

    suite('console.assert()', () => {
        test(`Prints params and doesn't resolve format specifiers`, () => {
            doAssertForString(Runtime.makeAssert('Fail %s 123', 456), 'Assertion failed: Fail %s 123 456\n    at myFn (/script/a.js:5:1)', true);
        });
    });
});

/**
 * Build the Chrome notifications objects for various console APIs.
 */
namespace Runtime {
    /**
     * Make a mock message of any type.
     * @param type - The type of the message
     * @param params - The list of parameters passed to the log function
     * @param overrideProps - An object of props that the message should have. The rest are filled in with defaults.
     */
    function makeMockMessage(type: string, args: any[], overrideProps?: any): Crdp.Runtime.ConsoleAPICalledEvent {
        const message: Crdp.Runtime.ConsoleAPICalledEvent = <any>{
            type,
            executionContextId: 2,
            timestamp: Date.now(),
            args: args.map(param => {
                const remoteObj = { type: typeof param, value: param, description: '' + param };
                if (param === null) {
                    (<any>remoteObj).subtype = 'null';
                }

                return remoteObj;
            })
        };

        if (overrideProps) {
            for (let propName in overrideProps) {
                if (overrideProps.hasOwnProperty(propName)) {
                    message[propName] = overrideProps[propName];
                }
            }
        }

        return message;
    }

    /**
     * Returns a mock ConsoleAPICalledEvent with the given argument values.
     * You can pass '$obj' to get an object.
     */
    export function makeLog(...args: any[]): Crdp.Runtime.ConsoleAPICalledEvent {
        const msg = makeMockMessage('log', args);
        msg.args.forEach(arg => {
            if (arg.value === '$obj') {
                arg.value = undefined;
                arg.type = 'object';
                arg.description = 'Object';
                arg.objectId = '$obj';
            }

            return arg;
        });

        return msg;
    }

    export function makeAssert(...args: any[]): Crdp.Runtime.ConsoleAPICalledEvent {
        const fakeStackTrace: Crdp.Runtime.StackTrace = {
            callFrames: [{ url: '/script/a.js', lineNumber: 4, columnNumber: 1, scriptId: '1', functionName: 'myFn' }]
        };
        return makeMockMessage('assert', args, { level: 'error', stackTrace: fakeStackTrace });
    }

    export function makeNetworkLog(text: string, url: string): Crdp.Runtime.ConsoleAPICalledEvent {
        return makeMockMessage('log', [text], { source: 'network', url, level: 'error' });
    }
}
