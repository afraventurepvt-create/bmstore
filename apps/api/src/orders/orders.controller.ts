import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Roles } from '../auth/decorators';
import { ListOrdersQuery, OrdersService, SetOrderStatusDto, SetPaymentStatusDto } from './orders.service';

@Roles('store_owner', 'staff')
@Controller('store')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get('dashboard') dashboard() { return this.orders.dashboard(); }
  @Get('orders') list(@Query() q: ListOrdersQuery) { return this.orders.list(q); }
  @Get('orders/:id') get(@Param('id', ParseUUIDPipe) id: string) { return this.orders.get(id); }
  @Post('orders/:id/status') @HttpCode(200) setStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetOrderStatusDto) { return this.orders.setStatus(id, dto); }
  @Post('orders/:id/payment-status') @HttpCode(200) setPayment(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetPaymentStatusDto) { return this.orders.setPaymentStatus(id, dto); }
  @Post('orders/:id/mark-paid') @HttpCode(200) markPaid(@Param('id', ParseUUIDPipe) id: string) { return this.orders.markCodPaid(id); }
}
