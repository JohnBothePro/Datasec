# Datasec MCP — Tools Inventory

Mapped against John's requested list (API V1.7).  
**Status:** `done` = implemented against docs; `stub` = registered but not in API / not supported.

Existing core tools kept and not broken.

| Tool | Section | Status | API method / notes |
|------|---------|--------|-------------------|
| datasec_status | Meta | done | Session status |
| datasec_set_env | Meta | done | test/prod switch |
| datasec_search_tickets | 2.5.2.11 | done | REST tickets/ |
| datasec_get_ticket | 2.5.2.5 | done | REST ticket/{id} |
| datasec_get_notes | 2.5.2.6 | done | getTicketNotes |
| datasec_get_links | 2.5.2.17 | done | getLinkedTickets |
| datasec_get_state_history | 2.5.2.19 | done | getTicketsStatesHist |
| datasec_add_note | 2.5.2.7 | done | addTicketNote |
| datasec_set_state | 2.5.2.13 | done | setTicketState |
| datasec_link_tickets | 2.5.2.14 | done | linkTicketToTicket |
| datasec_send_ticket_mail | — | **stub** | not in API V1.7 docs |
| datasec_get_document | 2.5.1.1 | done | REST documents/… |
| datasec_update_document | 2.5.1.2 | done | updateIndexValues2 |
| datasec_archive_document_soap | 2.5.1.3 | done | insertDoc2_1 |
| datasec_archive_document_rest | 2.5.1.4 | done | POST adddocument/ |
| datasec_search_by_document_type | 2.5.1.5 | done | REST indexes/ |
| datasec_search_in_process | 2.5.1.6 | done | REST collection-by-indexes/ |
| datasec_list_departments | 2.5.1.7 | done | REST departments/ |
| datasec_list_document_types | 2.5.1.8 | done | REST document-types/ |
| datasec_get_document_type_structure | 2.5.1.9 | done | REST document-types/{type}/ |
| datasec_create_master_ticket | 2.5.2.1 | done | createMasterTicket |
| datasec_create_ticket | 2.5.2.2 | done | createTicket |
| datasec_link_ticket_to_master | 2.5.2.3 | done | linkTicketToMaster |
| datasec_forward_ticket | 2.5.2.4 | done | forwardTicket |
| datasec_press_process_button | 2.5.2.8 | done | doTicketProcessAction |
| datasec_get_process_buttons | 2.5.2.9 | done | getTicketProcessButtons |
| datasec_get_process_fields | 2.5.2.10 | done | getTicketProcessFields |
| datasec_set_keyword | 2.5.2.12 | done | changeTicketKeyword |
| datasec_set_ticket_values | 2.5.2.15 | done | setTicketValues |
| datasec_list_keywords | 2.5.2.16 | done | getKeywords |
| datasec_get_process_fields_first_step | 2.5.2.18 | done | getTicketProcessFieldsFirstStep(+TicketNr) |
| datasec_get_latest_chat_messages | 2.5.2.20 | done | getNewTicketChatNotes |
| datasec_get_partner_id | 2.5.3.1 | done | getPartnerId |
| datasec_get_partner_contracts | 2.5.3.2 | done | getPartnerContracts |
| datasec_get_partner_base_data | 2.5.3.3 | done | getPartnerMasterdata |
| datasec_get_other_contract_partners_base | 2.5.3.4 | done | getAddPartnersMasterdata |
| datasec_get_partner_extended_data | 2.5.3.5 | done | getPartnerExtMasterdata |
| datasec_get_contract_conditions | 2.5.3.6 | done | getPartnerConditionsApp |
| datasec_get_app_users | 2.5.3.7 | done | getAppUser |
| datasec_get_business_partner_data | 2.5.3.8 | done | getGPMasterdata |
| datasec_mark_document_read | 2.5.3.9 | done | setDocRead |
| datasec_set_app_user_push_flags | 2.5.3.10 | done | setGRPfromPartner |
| datasec_update_contact_data | 2.5.3.11 | done | updatePartnerData |
| datasec_insert_eed_data | 2.5.3.12 | done | addEEDData |
| datasec_get_special_supplementary_data | 2.5.3.13 | done | getSpecialData |
| datasec_get_damage_reports | 2.5.4.1 | done | getPartnerMaintenanceIssues |
| datasec_get_news_ticker | 2.5.4.2 | done | getNewsticker |
| datasec_build_deeplink_base | Kap. 3.1 | done | URL builder (no network) |
| datasec_build_deeplink_akte | Kap. 3.2.2 | done | URL builder |
| datasec_build_deeplink_search | Kap. 3.2.3 | done | URL builder |
| datasec_build_deeplink_document_type | Kap. 3.2.4 | done | URL builder |
| datasec_build_deeplink_sammelbenutzer | Kap. 3.2.5 | done | URL builder |
| datasec_sso_status | Kap. 4 | **stub** | not supported in DOKU@WEB V1.7 |
| datasec_bridge_info | Kap. 1 | done | docs + optional BRIDGE_SHARE_PATH list |

## Counts

| | |
|--|--|
| Core (pre-existing) | 11 |
| Newly added | 43 |
| **Total tools** | **54** |
| Real implementations | 52 |
| Stubs | 2 (`datasec_send_ticket_mail`, `datasec_sso_status`) |

Among newly added: 42 real + 1 stub (`datasec_sso_status`). Pre-existing stub `datasec_send_ticket_mail` kept.

Write tools use `gateWrite` / `confirm`. Deep-link `includeAuthToken=true` requires **admin + confirm**; responses prefer redacted URL unless admin explicitly requested token.

## L1 Helpers (`datasec_h_*`) — additive, raw tools unchanged

Feature flag `DATASEC_HELPERS_ENABLED` (default true). Details: `docs/HELPERS.md`.

| Tool | Status | Notes |
|------|--------|--------|
| datasec_h_ask | done | Freitext-Router (Heuristik, kein LLM) |
| datasec_h_resolve | done | Crosswalk + optionaler Document-Index; nicht getPartnerId |
| datasec_h_find_tickets | done | PARTNERID + KEYWORD/SUBJECT; Straße nie KEYWORD |
| datasec_h_ticket_briefing | done | Ticket + Includes; Anlagen = TICKETANLAGEN+TICKETID |
| datasec_h_catalog | done | Cached keywords/statuses/doc_types/departments |
| datasec_h_partner_context | done | Stammdaten + optionale Tickets/Schäden |
| datasec_h_find_documents | done | TICKETARCHIV gesperrt |
| datasec_h_create_ticket | done | Preview ohne confirm; Gate bei confirm |
| datasec_h_add_note | done | Preview ohne confirm; Gate bei confirm |
| datasec_h_set_state | done | Preview ohne confirm; Gate bei confirm |
