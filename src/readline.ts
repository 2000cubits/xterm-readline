import { Terminal, ITerminalAddon, IDisposable } from "xterm";
import { Input, InputType, parseInput } from "./keymap";
import { State } from "./state";
import { History } from "./history";
import { Output, Tty } from "./tty";
import { Highlighter, IdentityHighlighter } from "./highlight";

interface ActiveRead {
  prompt: string;
  resolve: (input: string) => void;
  reject: (e: unknown) => void;
}

type CheckHandler = (text: string) => boolean;
type DefaultHandler = (input: Input) => void;
type CtrlCHandler = () => void;
type PauseHandler = (resume: boolean) => void;

export class Readline implements ITerminalAddon {
  private term: Terminal | undefined;
  private highlighter: Highlighter = new IdentityHighlighter();
  private history: History = new History(50);
  private activeRead: ActiveRead | undefined;
  private disposables: IDisposable[] = [];
  private watermark = 0;
  private highWatermark = 10000;
  private lowWatermark = 1000;
  private highWater = false;
  private disabled = false;
  public cancelPromise: boolean;
  private state: State = new State(
    ">",
    this.tty(),
    this.highlighter,
    this.history
  );
  private defaultHandler: DefaultHandler = (input: Input) => {
    return;
  };
  private checkHandler: CheckHandler = () => true;

  private pauseHandler: PauseHandler = (resume: boolean) => {
    return;
  };

  constructor() {
    this.history.restoreFromLocalStorage();
    this.cancelPromise = false;
  }

  /**
   * Activate this addon - this function is called by xterm's
   * loadAddon().
   *
   * @param term - The terminal this readline is attached to.
   */
  public activate(term: Terminal): void {
    this.term = term;
    this.term.onData(this.readData.bind(this));
    this.term.attachCustomKeyEventHandler(this.handleKeyEvent.bind(this));
  }

  public disable() {
    this.disabled = true;
  }

  public enable() {
    this.disabled = false;
  }

  /**
   * Dispose
   *
   */
  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  /**
   * Manually append a line to the top of the readline's history.
   *
   * @param text - The text to append to history.
   */
  public appendHistory(text: string) {
    this.history.append(text);
  }

  /**
   * Set the highlighter handler for this readline. This is used to
   * create custom highlighting functionality (e.g. for syntax highlighting
   * or bracket matching).
   *
   * @param highlighter - A handler to handle all highlight callbacks.
   */
  public setHighlighter(highlighter: Highlighter) {
    this.highlighter = highlighter;
  }

  public setDefaultHandler(defaultHandler: DefaultHandler) {
    this.defaultHandler = defaultHandler;
  }

  /**
   * Set the check callback. This callback is used by readline to determine if input
   * requires additiona lines when the user presses 'enter'.
   *
   * @param fn - A function (string) -> boolean that should return true if the input
   *             is complete, and false if a line (\n) should be added to the input.
   */
  public setCheckHandler(fn: CheckHandler) {
    this.checkHandler = fn;
  }

  /**
   * Set the callback to be called when the user presses ctrl-s/ctrl-q.
   *
   * @param fn - The pause handler
   */
  public setPauseHandler(fn: PauseHandler) {
    this.pauseHandler = fn;
  }

  /**
   * writeReady() may be used to implement basic output flow control. This function
   * will return false if the writes to the terminal initiated by Readline have
   * reached a highwater mark.
   *
   * @returns true if this terminal is accepting more input.
   */
  public writeReady(): boolean {
    return !this.highWater;
  }

  /**
   * Write text to the terminal.
   *
   * @param text - The text to write to the terminal.
   */
  public write(text: string) {
    if (text === "\n") {
      text = "\r\n";
    } else {
      text = text.replace(/^\n/, "\r\n");
      text = text.replace(/([^\r])\n/g, "$1\r\n");
    }
    const outputLength = text.length;
    this.watermark += outputLength;
    if (this.watermark > this.highWatermark) {
      this.highWater = true;
    }
    if (this.term) {
      this.term.write(text, () => {
        this.watermark = Math.max(this.watermark - outputLength, 0);
        if (this.highWater && this.watermark < this.lowWatermark) {
          this.highWater = false;
        }
      });
    }
  }

  /**
   * Write text to the terminal.
   *
   * @param text - The text to write to the terminal
   */
  public print(text: string) {
    return this.write(text);
  }

  /**
   * Write text to the terminal and append with "\r\n".
   *
   * @param text - The text to write to the terminal./
   * @returns
   */
  public println(text: string) {
    return this.write(text + "\r\n");
  }

  /**
   * Obtain an output interface to this terminal.
   *
   * @returns Output
   */
  public output(): Output {
    return this;
  }

  /**
   * Obtain a tty interface to this terminal.
   *
   * @returns A tty
   */
  public tty(): Tty {
    if (this.term?.options?.tabStopWidth !== undefined) {
      return new Tty(
        this.term.cols,
        this.term.rows,
        this.term.options.tabStopWidth,
        this.output()
      );
    } else {
      return new Tty(0, 0, 8, this.output());
    }
  }

  /**
   * Display the given prompt and wait for one line of input from the
   * terminal. The returned promise will be executed when a line has been
   * read from the terminal.
   *
   * @param prompt The prompt to use.
   * @returns A promise to be called when the input has been read.
   */
  public read(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {      
      if (this.term === undefined) {
        reject("addon is not active");
        return;
      }

      if (this.cancelPromise) {
        //reject(new Error("Operation cancelled"));
      }

      this.state = new State(
        prompt,
        this.tty(),
        this.highlighter,
        this.history
      );
      this.state.refresh();
      this.activeRead = { prompt, resolve, reject };
    });
  }

  public abortActiveRead() {
    this.activeRead?.reject(new Error("Operation aborted"));
    this.activeRead = undefined;
  }

  private handleKeyEvent(event: KeyboardEvent): boolean {
    if (event.key === "Enter" && event.shiftKey) {
      if (event.type === "keydown") {
        this.readKey({
          inputType: InputType.ShiftEnter,
          data: ["\r"],
        });
      }
      return false;
    }
    return true;
  }

  private readData(data: string) {
    const input = parseInput(data);
    if (
      input.length > 1 ||
      (input[0].inputType === InputType.Text && input[0].data.length > 1)
    ) {
      this.readPaste(input);
      return;
    }
    this.readKey(input[0]);
  }

  private readPaste(input: Input[]) {
    const mappedInput = input.map((it) => {
      if (it.inputType === InputType.Enter) {
        return { inputType: InputType.Text, data: ["\n"] };
      }
      return it;
    });

    for (const it of mappedInput) {
      if (it.inputType === InputType.Text) {
        this.state.editInsert(it.data.join(""));
      } else {
        this.readKey(it);
      }
    }
  }

  private readKey(input: Input) {
    if (this.disabled) {
      return;
    }

    switch (input.inputType) {
      case InputType.Text:
        this.state.editInsert(input.data.join(""));
        break;
      case InputType.AltEnter:
      case InputType.ShiftEnter:
        this.state.editInsert("\n");
        break;
      case InputType.Enter:
        if (this.checkHandler(this.state.buffer())) {
          this.state.moveCursorToEnd();
          this.term?.write("\r\n");
          this.history.append(this.state.buffer());
          this.activeRead?.resolve(this.state.buffer());
          this.activeRead = undefined;
        } else {
          this.state.editInsert("\n");
        }
        break;
      // case InputType.CtrlC:
      //   this.state.moveCursorToEnd();
      //   this.term?.write("^C\r\n");        
      //   this.state = new State(
      //     this.activeRead.prompt,
      //     this.tty(),
      //     this.highlighter,
      //     this.history
      //   );
      //   this.state.refresh();
      //   break;
      case InputType.CtrlS:
        this.pauseHandler(false);
        break;
      case InputType.CtrlU:
        this.state.update("");
        break;
      case InputType.CtrlK:
        this.state.editDeleteEndOfLine();
        break;
      case InputType.CtrlQ:
        this.pauseHandler(true);
        break;
      case InputType.CtrlL:
        this.state.clearScreen();
        break;
      case InputType.Home:
        this.state.moveCursorHome();
        break;
      case InputType.End:
        this.state.moveCursorEnd();
        break;
      case InputType.Backspace:
        this.state.editBackspace(1);
        break;
      case InputType.Delete:
        this.state.editDelete(1);
        break;
      case InputType.ArrowLeft:
        this.state.moveCursorBack(1);
        break;
      case InputType.ArrowRight:
        this.state.moveCursorForward(1);
        break;
      case InputType.ArrowUp:
        this.state.moveCursorUp(1);
        break;
      case InputType.ArrowDown:
        this.state.moveCursorDown(1);
        break;

      default:
        this.defaultHandler(input);
      break

      // case InputType.UnsupportedControlChar:
      // case InputType.UnsupportedEscape:        
      //   break;
    }
  }
}
