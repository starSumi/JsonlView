export { CancellationRegistry } from './cancellation';
export { isExtensionMessage } from './extension-message';
export {
  createProtocolEnvelope,
  isProtocolEnvelope,
  readProtocolIdentity,
  validateProtocolEnvelope,
  MAX_PROTOCOL_DOCUMENT_ID_LENGTH,
  MAX_PROTOCOL_GENERATION_LENGTH,
  MAX_PROTOCOL_REQUEST_ID_LENGTH,
  type ProtocolEnvelopeInput,
  type ProtocolEnvelopeValidation,
  type ProtocolIdentity,
} from './protocol';
