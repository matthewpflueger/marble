import * as WebSocket from 'ws';
import * as O from 'fp-ts/lib/Option';
import * as T from 'fp-ts/lib/Task';
import * as TE from 'fp-ts/lib/TaskEither';
import { forkJoin, Observable, of, defer } from 'rxjs';
import { catchError, mapTo } from 'rxjs/operators';
import { constant, constVoid, flow, pipe } from 'fp-ts/lib/function';
import { ContextProvider, Event, LoggerToken, LoggerTag, LoggerLevel } from '@marblejs/core';
import { EventTransformer } from '../transformer/websocket.transformer.interface';
import { WebsocketReadyStateMap } from '../websocket.interface';
import { sendMessage } from './websocket.server.helper';

type ResponseHandlerContext = {
  eventTransformer: EventTransformer<any>;
  ask: ContextProvider;
};

type ClientResponseHandlerContext = ResponseHandlerContext & { client: WebSocket & { id?: string }}
type ServerResponseHandlerContext = ResponseHandlerContext & { server: WebSocket.Server }

type ClientResponseHandler = (ctx: ClientResponseHandlerContext) => <T extends Event>(event: T) => Observable<boolean>;
type ServerResponseHandler = (ctx: ServerResponseHandlerContext) => <T extends Event>(event: T) => Observable<boolean>;

const log = (level: LoggerLevel) => (ask: ContextProvider) => (message: string): T.Task<void> =>
  pipe(
    ask(LoggerToken),
    O.map(logger => logger({ level, message, tag: LoggerTag.WEBSOCKETS, type: 'ServerResponseHandler' })),
    O.getOrElse(constant(constVoid)),
    T.fromIO);

const logWarn = log(LoggerLevel.WARN);
const logError = log(LoggerLevel.ERROR);

/**
 * Try to emit an event to given WebSocket client
 */
export const emitEvent: ClientResponseHandler = ({ client, eventTransformer, ask }) => <T extends Event>(event: T) => {
  const skipSendingEvent: T.Task<boolean> =
    pipe(
      logWarn(ask)(`Trying to send an event for client which is ${WebsocketReadyStateMap[client.readyState]}`),
      T.map(constant(false)),
    );

  const tryToSendEvent: T.Task<boolean> =
    pipe(
      TE.tryCatch(
        () => pipe(eventTransformer.encode(event), sendMessage(client)),
        constant(`An error occured while sending and event to client "${client.id}"`)),
      TE.fold(
        flow(logError(ask), T.map(constant(false))),
        constant(T.of(true)),
    ));

  const isConnectionOpen = client.readyState === WebSocket.OPEN;

  return pipe(
    defer(pipe(isConnectionOpen ? tryToSendEvent : skipSendingEvent)),
    catchError(constant(of(false))));
};

/**
 * Broadcast event to all connected clients
 */
export const broadcastEvent: ServerResponseHandler = ({ server, eventTransformer, ask }) => <T extends Event>(event: T) =>
  pipe(
    forkJoin([...server.clients].map(client => emitEvent({ client, eventTransformer, ask })(event))),
    catchError(constant(of(false))),
    mapTo(true),
  );
