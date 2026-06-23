# Registry-Based Implementation Plan

## Screen → API Mapping

| Screen | Operation | URL | Status Variable | Pagination |
|--------|-----------|-----|----------------|------------|
| Dashboard Stats | `GetStateCount` | `orchestrator/graphql?` | `pendingToAccept` | N/A (returns all counts) |
| To Accept | `GetShipmentListByOrderId` | `orchestrator/graphql?` | `pendingToAccept` | pageNum/pageSize |
| To Pack | `GetShipmentListByOrderId` | `orchestrator/graphql?` | `pendingToPack` | pageNum/pageSize |
| Pending RTD | `GetShipmentListByOrderId` | `orchestrator/graphql?` | `pendingToDispatch` | pageNum/pageSize |
| In Transit | `GetShipmentListByOrderId` | `orchestrator/graphql?` | `inTransit` | pageNum/pageSize |
| Completed | `GetShipmentListByOrderId` | `orchestrator/graphql?` | `completed` | pageNum/pageSize |
| Upcoming | `GetShipmentListByOrderId` | `orchestrator/graphql?` | `upcoming` | pageNum/pageSize |
| Order Detail | `content_by_id` | `orchestrator/graphql?` | shipment_id | N/A |

## Response Fields Used

### GetStateCount Response
```
data.shipmentStatesCountAndBreakdown.shipmentStatesCountMetrics.shipmentStatesCount
  .pendingToAccept
  .pendingToPack
  .pendingLabel
  .pendingRTD
  .pendingToDispatch
  .inTransit
  .completed
  .upcoming
```

### GetShipmentListByOrderId Response
```
data.filteredShipmentGroups.shipmentGroups[].shipments[]
  .shippingId
  .orderId
  .sellerPrice
  .dispatchByDate
  .dispatchServiceTier
  .shipmentType
  .isLarge
  .isMps
  .locationId
  .shipmentContents.shipmentGroupSpecs[].listing.product
    .title, .sku, .fsn, .primaryImageUrl
  .shipmentContents.shipmentGroupSpecs[].quantity
  .tracking.trackingId, .courierName
  .statusHistory.*
  .shipmentOrderItems[].orderItemId, .quantity, .status
data.filteredShipmentGroups.pageInfo
  .hasMore
  .total
```

## Seller Constants (from discovery)
- seller_id: 2bf45ff289624a81
- location_id: LOCa65cd43100b24f388dd9588ed2389e63
- GraphQL URL: https://seller.flipkart.com/orchestrator/graphql?

## Required Headers (from auth-tokens.json)
- fk-csrf-token (from session cookies)
- x-user-id: seller_id
- x-location-id: location_id
- x-client-id: SD
- x-internal-env-type: WEB
- content-type: application/json
- Cookie (from session)

## Files to Create
1. registry-api-client.js — Loads registry, constructs requests, handles auth
2. Rewrite flipkart-api-client.js — Use registry-api-client instead of old intercepted payloads

## Files to Modify
1. main.js — Load registry on startup, pass to client
2. renderer/app.js — No changes needed (IPC calls stay same)

## Disabled Features
- Label Download → "Coming Soon"
- PDF Merge → "Coming Soon"
- RTD → "Coming Soon"
- Print → "Coming Soon"
