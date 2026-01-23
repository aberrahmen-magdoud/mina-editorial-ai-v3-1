import { v4 as uuidv4 } from "uuid";

export function generationIdentifiers(generationId) {
  return {
    mg_id: `generation:${generationId}`,
    mg_generation_id: generationId,
    mg_record_type: "generation",
  };
}

export function stepIdentifiers(generationId, stepNo) {
  return {
    mg_id: `mma_step:${generationId}:${stepNo}`,
    mg_generation_id: generationId,
    mg_record_type: "mma_step",
    mg_step_no: stepNo,
  };
}

export function eventIdentifiers(eventId) {
  return {
    mg_id: `mma_event:${eventId}`,
    mg_record_type: "mma_event",
  };
}

export function newUuid() {
  return uuidv4();
}
