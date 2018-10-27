import { boolFromValue, RuntimeState } from './runtime.js';
import { Runner } from './runner.js';
import { i18n, i18nWithLanguage } from './i18n.js';
import {
  apiboardFromJboard, apiboardToJboard,
  gbbFromJboard, gbbToJboard,
} from './board_formats.js';
import { ValueStructure } from './value.js';
import {
  N_PatternWildcard, N_PatternStructure, N_PatternTuple, N_PatternTimeout
} from './ast.js';

const DEFAULT_INFINITE_LOOP_TIMEOUT = 20000; /* millisecs */
const DEFAULT_LANGUAGE = 'es';

/* load a board in the API format into a fresh RuntimeState */
function apiboardToState(apiboard) {
  let state = new RuntimeState();
  state.load(apiboardToJboard(apiboard));
  return state;
}

/* Dump a RuntimeState to a board in the API format */
function apiboardFromState(state) {
  return apiboardFromJboard(state.dump());
}

/* Backwards-compatible type/value with special cases for some types */
function apivalueFromValue(value) {
  const composedValue = (componentKind) => {
    const elements = value[componentKind].map((it) => {
      const apiValue = apivalueFromValue(it);
      const value = apiValue && apiValue.value;

      return value;
    });

    return {
      type: value.type().toString(),
      value: elements
    };
  };

  if (value === null) {
    return null;
  }
  if (value.isInteger()) {
    return {
      type: i18n('TYPE:Integer'),
      value: value.asNumber()
    };
  } else if (value.isBoolean()) {
    return {
      type: i18n('TYPE:Bool'),
      value: boolFromValue(value)
    };
  } else if (value.isString()) {
    return {
      type: i18n('TYPE:String'),
      value: value.string
    };
  } else if (value.isTuple()) {
    return composedValue('components');
  } else if (value.isList()) {
    return composedValue('elements');
  } else if (value.isStructure()) {
    return {
      type: value.typeName,
      value: value.toString()
    };
  } else {
    return {
      type: value.type().toString(),
      value: value.toString()
    };
  }
}

class GobstonesInterpreterError {

  constructor(exception) {
    this.message = exception.message;
    this.reason = {
      code: exception.reason,
      detail: exception.args
    };
    this.on = {
      range: {
        start: {
          row: exception.startPos.line,
          column: exception.startPos.column
        },
        end: {
          row: exception.endPos.line,
          column: exception.endPos.column
        },
      },
      region: exception.startPos.region
    };
  }

}

class ParseError extends GobstonesInterpreterError {
  constructor(exception) {
    super(exception);
  }
}

class ExecutionError extends GobstonesInterpreterError {
  constructor(exception, snapshots, regionStack) {
    super(exception);

    const isTimeout = this.reason.code === 'timeout';
    this.snapshots = isTimeout
      ? [snapshots[snapshots.length - 1]]
      : snapshots;
    this.on.regionStack = regionStack;
  }
}

class NormalExecutionResult {
  constructor(finalBoard, snapshots, returnValue) {
    this.finalBoard = finalBoard;
    this.snapshots = snapshots;
    this.returnValue = apivalueFromValue(returnValue);

    /* Actual return value */
    this.actualReturnValue = returnValue;
  }
}

class InteractiveExecutionResult {
  constructor(state) {
    this.keys = this._collectKeyNames(state);
    this.timeout = this._timeoutValue(state);
    this.onInit = this._onInitFunction(state);
    this.onKey = this._onKeyFunction(state);
    this.onTimeout = this._onTimeoutFunction(state);
  }

  _hasInit(state) {
    for (let branch of state.runner.symbolTable.program.branches) {
      let p = branch.pattern;
      if (p.tag === N_PatternStructure &&
          p.constructorName.value === i18n('CONS:INIT')) {
        return true;
      }
    }
    return false;
  }

  _hasTimeout(state) {
    return this.timeout !== null;
  }

  _collectKeyNames(state) {
    let keys = [];
    for (let branch of state.runner.symbolTable.program.branches) {
      let p = branch.pattern;
      if (p.tag === N_PatternStructure &&
          p.constructorName.value !== i18n('CONS:INIT')) {
        keys.push(p.constructorName.value);
      }
    }
    return keys;
  }

  _timeoutValue(state) {
    for (let branch of state.runner.symbolTable.program.branches) {
      if (branch.pattern.tag === N_PatternTimeout) {
        return branch.pattern.timeout;
      }
    }
    return null;
  }

  /* Return a function that, when called, continues running
   * the interactive program feeding it with the INIT event.
   *
   * If the interactive program does not have an entry for the
   * INIT event, the returned function has no effect.
   */
  _onInitFunction(state) {
    if (this._hasInit(state)) {
      let self = this;
      return function () {
        return i18nWithLanguage(state.language, () => {
          return self._onEvent(
            state,
            new ValueStructure(i18n('TYPE:Event'), i18n('CONS:INIT'))
          );
        });
      };
    } else {
      return function () {
        return i18nWithLanguage(state.language, () => {
          return apiboardFromState(state.runner.globalState);
        });
      };
    }
  }

  /* Return a function that, when called, continues running
   * the interactive program feeding it with the TIMEOUT event.
   *
   * If the interactive program does not have an entry for the
   * TIMEOUT event, the returned function has no effect.
   */
  _onTimeoutFunction(state) {
    if (this._hasTimeout(state)) {
      let self = this;
      return function () {
        return i18nWithLanguage(state.language, () => {
          return self._onEvent(
            state,
            new ValueStructure(i18n('TYPE:Event'), i18n('CONS:TIMEOUT'))
          );
        });
      };
    } else {
      return function () {
        return i18nWithLanguage(state.language, () => {
          return apiboardFromState(state.runner.globalState);
        });
      };
    }
  }

  /* Return a function that, when called with a key code, continues running
   * the interactive program feeding it with the given key event.
   *
   * If the interactive program does not have an entry for the given
   * key, this results in a runtime error.
   */
  _onKeyFunction(state) {
    let self = this;
    return function (keyCode) {
      return i18nWithLanguage(state.language, () => {
        return self._onEvent(
          state,
          new ValueStructure(i18n('TYPE:Event'), keyCode)
        );
      });
    };
  }

  /* Continue running the interactive program feeding it with the given
   * eventValue.
   * On success, return a Board.
   * On failure, return an ExecutionError. */
  _onEvent(state, eventValue) {
    return i18nWithLanguage(state.language, () => {
      try {
        state.runner.executeEventWithTimeout(
          eventValue,
          state.infiniteLoopTimeout
        );
        return apiboardFromState(state.runner.globalState);
      } catch (exception) {
        if (exception.isGobstonesException === undefined) {
          throw exception;
        }
        return new ExecutionError(
                 exception,
                 [],
                 state.runner.regionStack()
               );
      }
    });
  }

}

class SnapshotTaker {

  constructor(runner) {
    this._runner = runner;
    this._snapshots = [];
  }

  takeSnapshot(routineName, position, callStack, globalState) {
    if (this._shouldTakeSnapshot(routineName, callStack)) {
      this._snapshots.push(
        this._snapshot(routineName, position, callStack, globalState)
      );
    }
  }

  snapshots() {
    return this._snapshots;
  }

  _snapshot(routineName, position, callStack, globalState) {
    let snapshot = {};
    snapshot.contextNames = [];
    for (let stackFrame of callStack) {
      let name = stackFrame.routineName;
      if (name !== 'program') {
        name = name + '-' + stackFrame.uniqueFrameId.toString();
      }
      snapshot.contextNames.push(name);
    }
    snapshot.board = apiboardFromState(globalState);
    snapshot.region = position.region;
    snapshot.regionStack = this._runner.regionStack();
    return snapshot;
  }

  _shouldTakeSnapshot(routineName, callStack) {
    let routineNameStack = [];
    for (let stackFrame of callStack) {
      routineNameStack.push(stackFrame.routineName);
    }

    if (this._runner.primitives.isProcedure(routineName)) {
      /* A primitive procedure must be recorded if there are no
       * atomic routines anywhere in the call stack. */
      return this._noAtomicRoutines(routineNameStack);
    } else {
      /* Other routines must be recorded if they have the 'recorded'
       * attribute, and, moreover, there are no atomic routines other
       * than the last one in the call stack. */
      routineNameStack.pop();
      return this._isRecorded(routineName)
          && this._noAtomicRoutines(routineNameStack);
    }
  }

  _noAtomicRoutines(routineNameStack) {
    for (let routineName of routineNameStack) {
      if (this._isAtomic(routineName)) {
        return false;
      }
    }
    return true;
  }

  _isAtomic(routineName) {
    if (routineName === 'program') {
      return false;
    } else if (this._runner.primitives.isProcedure(routineName)) {
      /* Primitive procedure */
      return false;
    } else if (this._runner.symbolTable.isProcedure(routineName)) {
      /* User-defined procedure */
      return false;
    } else {
      /* Function */
      return true;
    }
  }

  _isRecorded(routineName) {
    if (routineName === 'program') {
      return true;
    } else if (this._runner.primitives.isProcedure(routineName)) {
      /* Primitive procedure */
      return true;
    } else if (this._runner.symbolTable.isProcedure(routineName)) {
      /* User-defined procedure */
      return false;
    } else {
      /* Function */
      return false;
    }
  }

}

class ParseResult {

  constructor(state) {
    if (state.runner.symbolTable.program === null) {
      this.program = null;
    } else if (state.runner.symbolTable.isInteractiveProgram()) {
      this.program = this._resultForInteractiveProgram(state);
    } else {
      this.program = this._resultForProgram(state);
    }
    this.declarations = this._collectDeclarations(state.runner);
    this.getAttributes = function (globalName) {
      return state.runner.symbolTable.getAttributes(globalName);
    };
  }

  _resultForProgram(state) {
    let program = {};
    program.alias = 'program';
    program.interpret = function (board) {
      let snapshotTaker = new SnapshotTaker(state.runner);

      return i18nWithLanguage(state.language, () => {
        try {
          state.runner.compile();
          state.runner.executeWithTimeoutTakingSnapshots(
            apiboardToState(board),
            state.infiniteLoopTimeout,
            snapshotTaker.takeSnapshot.bind(snapshotTaker)
          );

          let finalBoard = apiboardFromState(state.runner.globalState);
          let returnValue = state.runner.result;
          return new NormalExecutionResult(
            finalBoard,
            snapshotTaker.snapshots(),
            returnValue,
          );
        } catch (exception) {
          if (exception.isGobstonesException === undefined) {
            throw exception;
          }

          return new ExecutionError(
                   exception,
                   snapshotTaker.snapshots(),
                   state.runner.regionStack()
                 );
        }
      });
    };
    return program;
  }

  _resultForInteractiveProgram(state) {
    let program = {};
    program.alias = 'interactiveProgram';
    program.interpret = function (board) {
      return i18nWithLanguage(state.language, () => {
        try {
          state.runner.compile();
          state.runner.initializeVirtualMachine(apiboardToState(board));
          return new InteractiveExecutionResult(state);
        } catch (exception) {
          if (exception.isGobstonesException === undefined) {
            throw exception;
          }
          return new ExecutionError(
                   exception,
                   [],
                   state.runner.regionStack()
                 );
        }
      });
    };
    return program;
  }

  _collectDeclarations(runner) {
    let declarations = [];
    for (let name of runner.symbolTable.allProcedureNames()) {
      if (runner.primitives.isProcedure(name)) {
        continue; /* Skip primitive procedures */
      }
      declarations.push({
        alias: 'procedureDeclaration',
        name: name
      });
    }
    for (let name of runner.symbolTable.allFunctionNames()) {
      if (runner.primitives.isFunction(name)) {
        continue; /* Skip primitive functions */
      }
      declarations.push({
        alias: 'functionDeclaration',
        name: name
      });
    }
    return declarations;
  }

}

export class GobstonesInterpreterAPI {

  constructor() {
    /* Internal state of the interpreter */
    let state = {
      infiniteLoopTimeout: DEFAULT_INFINITE_LOOP_TIMEOUT,
      language: DEFAULT_LANGUAGE,
      runner: new Runner(),
    };

    this.config = {
      setLanguage: function (code) {
        state.language = code;
      },
      setInfiniteLoopTimeout: function (milliseconds) {
        state.infiniteLoopTimeout = milliseconds;
      },
      setXGobstonesEnabled: function (isEnabled) {
        /* TODO */
      },
    };

    this.gbb = {
      /* Convert a string representing a board in GBB format
       * to a board in the "API" format. */
      read: function (gbb) {
        return apiboardFromJboard(gbbToJboard(gbb));
      },
      /* Convert a board in the "API" format to a string representing
       * a board in GBB format. */
      write: function (apiboard) {
        return gbbFromJboard(apiboardToJboard(apiboard));
      },
    };

    this.getAst = function (sourceCode) {
      return this._withState(sourceCode, false, (state) =>
        state.runner.abstractSyntaxTree.toMulangLike()
      );
    };

    this.parse = function (sourceCode) {
      return this._withState(sourceCode, true, (state) =>
        new ParseResult(state)
      );
    };

    this._withState = function (sourceCode, useLinter, action) {
      return i18nWithLanguage(state.language, () => {
        try {
          state.runner.initialize();
          state.runner.parse(sourceCode);
          /* Disable checking whether there is a main 'program' present. */
          state.runner.enableLintCheck(
            'source-should-have-a-program-definition', false
          );
          if (useLinter) state.runner.lint();
          return action(state);
        } catch (exception) {
          if (exception.isGobstonesException === undefined) {
            throw exception;
          }
          return new ParseError(exception);
        }
      });
    };

  }

}

