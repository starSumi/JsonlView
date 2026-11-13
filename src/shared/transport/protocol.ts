import { PROTOCOL_VERSION, type ProtocolEnvelope, type ProtocolEnvelopeInput } from '../contracts';

export {
  isProtocolEnvelope,
  readProtocolIdentity,
  validateProtocolEnvelope,
  type ProtocolEnvelopeValidation,
  type ProtocolIdentity,
} from '../contracts/envelope';
export {
  MAX_PROTOCOL_DOCUMENT_ID_LENGTH,
  MAX_PROTOCOL_GENERATION_LENGTH,
  MAX_PROTOCOL_REQUEST_ID_LENGTH,
} from '../contracts/identity';
export type { ProtocolEnvelopeInput } from '../contracts/envelope';

/** Adds the current protocol version and preserves explicitly classified delivery. */
export function createProtocolEnvelope<TType extends string, TPayload>(
  input: ProtocolEnvelopeInput<TType, TPayload>,
): ProtocolEnvelope<TType, TPayload> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    ...(input.direction === undefined ? {} : { direction: input.direction }),
    ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
    type: input.type,
    documentId: input.documentId,
    generation: input.generation,
    ...(input.epoch === undefined ? {} : { epoch: input.epoch }),
    requestId: input.requestId,
    payload: input.payload,
  };
}
