import { HttpException, HttpStatus } from '@nestjs/common';

/** 429 with a Retry-After hint (seconds). The exception filter writes the header. */
export class TooManyRequestsException extends HttpException {
  constructor(readonly retryAfterSeconds: number, message = 'Too many attempts, try again later') {
    super({ statusCode: HttpStatus.TOO_MANY_REQUESTS, message, retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
