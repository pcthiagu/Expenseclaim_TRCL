/* GENERATED from legacy/prototype/js/data.js by scripts/genDemoSeed.ts. TEST-ONLY seed for the fake backend engine (the data the browser tests start from). */
import type { Employee, Receipt, TravelClaimRecord } from '@/types/domain';

export const SEED_EMPLOYEES = [
  {
    "code": "800000",
    "name": "Selva Kumar",
    "department": "Sales",
    "costCentre": "CC-102 · Sales",
    "grade": "G4"
  },
  {
    "code": "800001",
    "name": "Karthik R",
    "department": "Engineering",
    "costCentre": "CC-101 · Engineering",
    "grade": "G3"
  },
  {
    "code": "800002",
    "name": "Mani Bharathi",
    "department": "Operations",
    "costCentre": "CC-103 · Operations",
    "grade": "G3"
  },
  {
    "code": "800003",
    "name": "Divya Sree",
    "department": "Finance",
    "costCentre": "CC-104 · Finance",
    "grade": "G2"
  },
  {
    "code": "800004",
    "name": "Arun Prasad",
    "department": "Engineering",
    "costCentre": "CC-101 · Engineering",
    "grade": "G4"
  }
] as unknown as Employee[];

export const SEED_USERS = {
  "employee": {
    "role": "employee",
    "roleLabel": "Employee",
    "code": "800001",
    "name": "Karthik R",
    "designation": "Senior Engineer",
    "department": "Engineering",
    "costCentre": "CC-101 · Engineering",
    "reportingTo": "Priya Natarajan"
  },
  "admin": {
    "role": "admin",
    "roleLabel": "Admin · Approver",
    "code": "700010",
    "name": "Priya Natarajan",
    "designation": "HR Admin",
    "department": "Human Resources",
    "costCentre": "CC-105 · HR",
    "reportingTo": "—"
  }
} as const;

export const SEED_RECORDS = [
  {
    "id": "seed-1",
    "kind": "claim",
    "requestNumber": "800001/2026/0101",
    "employeeCode": "800001",
    "employeeName": "Karthik R",
    "costCentre": "CC-101 · Engineering",
    "expenseType": "fuel",
    "purpose": "Client meetings at Guindy and Tidel Park",
    "requestDate": "2026-07-18",
    "status": "approved",
    "submittedOn": "2026-07-18",
    "approvedOn": "2026-07-20",
    "approver": "Priya Natarajan",
    "employeeComments": "Two client visits on the same day.",
    "approverComments": "Verified against the visit log.",
    "rejectionReason": "",
    "createdAt": "2026-07-18T09:12:00",
    "updatedAt": "2026-07-20T11:40:00",
    "items": [
      {
        "id": "seed-2",
        "itemKey": "l_fuel_4w",
        "fields": {
          "date": "2026-07-18",
          "fromLocation": "Velachery",
          "toLocation": "Tidel Park",
          "fromKm": 23410,
          "toKm": 23452,
          "nonAccountableKm": 0,
          "totalKm": 42,
          "amount": 378
        },
        "attachments": [],
        "approvedAmount": 378,
        "approverRemarks": ""
      }
    ]
  },
  {
    "id": "seed-3",
    "kind": "claim",
    "requestNumber": "800001/2026/0102",
    "employeeCode": "800001",
    "employeeName": "Karthik R",
    "costCentre": "CC-101 · Engineering",
    "expenseType": "medical",
    "purpose": "Annual eye check-up and lab tests",
    "requestDate": "2026-08-14",
    "status": "approved",
    "submittedOn": "2026-08-14",
    "approvedOn": "2026-08-17",
    "approver": "Priya Natarajan",
    "employeeComments": "",
    "approverComments": "Glasses capped at the policy limit of ₹3,000.",
    "rejectionReason": "",
    "createdAt": "2026-08-14T15:02:00",
    "updatedAt": "2026-08-17T10:05:00",
    "items": [
      {
        "id": "seed-4",
        "itemKey": "s_med_lab",
        "fields": {
          "date": "2026-08-10",
          "billerName": "Apollo Diagnostics",
          "billNumber": "AD-55821",
          "amount": 2200,
          "remarks": "Full blood panel"
        },
        "attachments": [
          {
            "name": "apollo-lab-report.pdf",
            "size": 217088,
            "type": "application/pdf"
          }
        ],
        "approvedAmount": 2200,
        "approverRemarks": ""
      },
      {
        "id": "seed-5",
        "itemKey": "s_med_glasses",
        "fields": {
          "date": "2026-08-12",
          "billerName": "Lenskart",
          "billNumber": "LK-908812",
          "amount": 3800,
          "remarks": "Prescription glasses"
        },
        "attachments": [
          {
            "name": "lenskart-invoice.pdf",
            "size": 98304,
            "type": "application/pdf"
          }
        ],
        "approvedAmount": 3000,
        "approverRemarks": "Capped at policy limit"
      }
    ]
  },
  {
    "id": "seed-6",
    "kind": "claim",
    "requestNumber": "800001/2026/0103",
    "employeeCode": "800001",
    "employeeName": "Karthik R",
    "costCentre": "CC-101 · Engineering",
    "expenseType": "local",
    "purpose": "Weekend deployment support",
    "requestDate": "2026-08-30",
    "status": "rejected",
    "submittedOn": "2026-08-30",
    "approvedOn": "2026-09-01",
    "approver": "Priya Natarajan",
    "employeeComments": "Worked on the Saturday cut-over.",
    "approverComments": "",
    "rejectionReason": "Meals on non-working days need the manager pre-approval attached. Please resubmit with the approval mail.",
    "createdAt": "2026-08-30T19:22:00",
    "updatedAt": "2026-09-01T09:15:00",
    "items": [
      {
        "id": "seed-7",
        "itemKey": "l_food_nobill",
        "fields": {
          "date": "2026-08-29",
          "amount": 650,
          "remarks": "Dinner for the deployment team",
          "alongWith": "Arun Prasad, Divya Sree"
        },
        "attachments": [],
        "approvedAmount": 0,
        "approverRemarks": "Pre-approval missing"
      }
    ]
  },
  {
    "id": "seed-8",
    "kind": "claim",
    "requestNumber": "800001/2026/0104",
    "employeeCode": "800001",
    "employeeName": "Karthik R",
    "costCentre": "CC-101 · Engineering",
    "expenseType": "local",
    "purpose": "Vendor review at Ambattur",
    "requestDate": "2026-09-21",
    "status": "approved",
    "submittedOn": "2026-09-21",
    "approvedOn": "2026-09-22",
    "approver": "Priya Natarajan",
    "employeeComments": "",
    "approverComments": "",
    "rejectionReason": "",
    "createdAt": "2026-09-21T17:45:00",
    "updatedAt": "2026-09-22T12:00:00",
    "items": [
      {
        "id": "seed-9",
        "itemKey": "l_conveyance",
        "fields": {
          "date": "2026-09-21",
          "modeOfTravel": "Cab",
          "fromLocation": "Ambattur",
          "toLocation": "Velachery",
          "billNumber": "OLA-77120",
          "amount": 350
        },
        "attachments": [
          {
            "name": "ola-receipt.pdf",
            "size": 49152,
            "type": "application/pdf"
          }
        ],
        "approvedAmount": 350,
        "approverRemarks": ""
      },
      {
        "id": "seed-10",
        "itemKey": "l_food_lunch",
        "fields": {
          "date": "2026-09-21",
          "billerName": "Saravana Bhavan",
          "billNumber": "4471",
          "amount": 180
        },
        "attachments": [
          {
            "name": "lunch-bill.jpg",
            "size": 655360,
            "type": "image/jpeg"
          }
        ],
        "approvedAmount": 180,
        "approverRemarks": ""
      }
    ]
  },
  {
    "id": "seed-11",
    "kind": "claim",
    "requestNumber": "800001/2026/0105",
    "employeeCode": "800001",
    "employeeName": "Karthik R",
    "costCentre": "CC-101 · Engineering",
    "expenseType": "outside",
    "purpose": "Client visit – Bengaluru rollout",
    "requestDate": "2026-09-28",
    "travelFrom": "2026-09-23",
    "travelTo": "2026-09-25",
    "status": "submitted",
    "submittedOn": "2026-09-28",
    "approvedOn": null,
    "approver": null,
    "employeeComments": "Three-day rollout at the client site. Hotel booked through the travel desk.",
    "approverComments": "",
    "rejectionReason": "",
    "createdAt": "2026-09-27T20:10:00",
    "updatedAt": "2026-09-28T08:30:00",
    "items": [
      {
        "id": "seed-12",
        "itemKey": "o_ticket",
        "fields": {
          "date": "2026-09-20",
          "modeOfTravel": "Train",
          "fromLocation": "Chennai Central",
          "toLocation": "Bengaluru City",
          "fromDate": "2026-09-23",
          "fromTime": "06:00",
          "toDate": "2026-09-23",
          "toTime": "10:45",
          "billerName": "IRCTC",
          "billNumber": "PNR 4412098765",
          "amount": 2450
        },
        "attachments": [
          {
            "name": "irctc-ticket.pdf",
            "size": 188416,
            "type": "application/pdf"
          }
        ],
        "approvedAmount": null,
        "approverRemarks": ""
      },
      {
        "id": "seed-13",
        "itemKey": "o_lodge",
        "fields": {
          "date": "2026-09-25",
          "stayLocation": "Bengaluru",
          "fromDate": "2026-09-23",
          "toDate": "2026-09-25",
          "billerName": "Lemon Tree Hotel",
          "billNumber": "LT-2026-11890",
          "amount": 5600,
          "remarks": "Two nights, standard room"
        },
        "attachments": [
          {
            "name": "lemon-tree-invoice.pdf",
            "size": 309248,
            "type": "application/pdf"
          }
        ],
        "approvedAmount": null,
        "approverRemarks": ""
      },
      {
        "id": "seed-14",
        "itemKey": "o_boarding_bill",
        "fields": {
          "date": "2026-09-24",
          "stayLocation": "Bengaluru",
          "billerName": "Lemon Tree Hotel",
          "billNumber": "LT-F-5521",
          "amount": 1200,
          "remarks": "Breakfast and dinner at the hotel"
        },
        "attachments": [
          {
            "name": "hotel-food-bill.pdf",
            "size": 78848,
            "type": "application/pdf"
          }
        ],
        "approvedAmount": null,
        "approverRemarks": ""
      },
      {
        "id": "seed-15",
        "itemKey": "o_food_dinner",
        "fields": {
          "date": "2026-09-23",
          "time": "20:30",
          "stayLocation": "Bengaluru",
          "billerName": "Truffles",
          "billNumber": "TR-88213",
          "amount": 420,
          "alongWith": "Selva Kumar"
        },
        "attachments": [
          {
            "name": "truffles-bill.jpg",
            "size": 524288,
            "type": "image/jpeg"
          }
        ],
        "approvedAmount": null,
        "approverRemarks": ""
      },
      {
        "id": "seed-16",
        "itemKey": "o_conveyance",
        "fields": {
          "date": "2026-09-24",
          "modeOfTravel": "Cab",
          "stayLocation": "Bengaluru",
          "fromLocation": "Hotel",
          "toLocation": "Client site, Whitefield",
          "billerName": "Uber",
          "billNumber": "UB-6610",
          "amount": 380
        },
        "attachments": [
          {
            "name": "uber-receipt.pdf",
            "size": 41984,
            "type": "application/pdf"
          }
        ],
        "approvedAmount": null,
        "approverRemarks": ""
      }
    ]
  },
  {
    "id": "seed-17",
    "kind": "claim",
    "requestNumber": "800001/2026/0106",
    "employeeCode": "800001",
    "employeeName": "Karthik R",
    "costCentre": "CC-101 · Engineering",
    "expenseType": "medical",
    "purpose": "Consultation and medicines",
    "requestDate": "2026-10-03",
    "status": "draft",
    "submittedOn": null,
    "approvedOn": null,
    "approver": null,
    "employeeComments": "",
    "approverComments": "",
    "rejectionReason": "",
    "createdAt": "2026-10-03T18:40:00",
    "updatedAt": "2026-10-03T18:52:00",
    "items": [
      {
        "id": "seed-18",
        "itemKey": "s_med_consult",
        "fields": {
          "date": "2026-10-02",
          "billerName": "Dr. Meenakshi Clinic",
          "billNumber": "MC-1182",
          "amount": 800
        },
        "attachments": [
          {
            "name": "consult-receipt.pdf",
            "size": 56320,
            "type": "application/pdf"
          }
        ],
        "approvedAmount": null,
        "approverRemarks": ""
      },
      {
        "id": "seed-19",
        "itemKey": "s_med_rx",
        "fields": {
          "date": "2026-10-02",
          "billerName": "MedPlus",
          "billNumber": "MP-449021",
          "amount": 1450,
          "remarks": "As per prescription"
        },
        "attachments": [
          {
            "name": "medplus-bill.jpg",
            "size": 491520,
            "type": "image/jpeg"
          }
        ],
        "approvedAmount": null,
        "approverRemarks": ""
      }
    ]
  },
  {
    "id": "seed-20",
    "kind": "claim",
    "requestNumber": "800000/2026/0012",
    "employeeCode": "800000",
    "employeeName": "Selva Kumar",
    "costCentre": "CC-102 · Sales",
    "expenseType": "outside",
    "purpose": "Partner meet – Hyderabad",
    "requestDate": "2026-09-10",
    "travelFrom": "2026-09-07",
    "travelTo": "2026-09-08",
    "status": "approved",
    "submittedOn": "2026-09-10",
    "approvedOn": "2026-09-11",
    "approver": "Priya Natarajan",
    "employeeComments": "",
    "approverComments": "",
    "rejectionReason": "",
    "createdAt": "2026-09-10T10:00:00",
    "updatedAt": "2026-09-11T16:20:00",
    "items": [
      {
        "id": "seed-21",
        "itemKey": "o_ticket",
        "fields": {
          "date": "2026-09-05",
          "modeOfTravel": "Flight",
          "fromLocation": "Chennai",
          "toLocation": "Hyderabad",
          "fromDate": "2026-09-07",
          "fromTime": "07:15",
          "toDate": "2026-09-08",
          "toTime": "21:00",
          "billerName": "IndiGo",
          "billNumber": "PNR Q7X2LM",
          "amount": 3500
        },
        "attachments": [
          {
            "name": "indigo-eticket.pdf",
            "size": 143360,
            "type": "application/pdf"
          }
        ],
        "approvedAmount": 3500,
        "approverRemarks": ""
      }
    ]
  },
  {
    "id": "seed-22",
    "kind": "claim",
    "requestNumber": "800000/2026/0013",
    "employeeCode": "800000",
    "employeeName": "Selva Kumar",
    "costCentre": "CC-102 · Sales",
    "expenseType": "outside",
    "purpose": "Quarterly business review – Hyderabad",
    "requestDate": "2026-10-01",
    "travelFrom": "2026-09-28",
    "travelTo": "2026-09-30",
    "status": "submitted",
    "submittedOn": "2026-10-01",
    "approvedOn": null,
    "approver": null,
    "employeeComments": "QBR with the regional team.",
    "approverComments": "",
    "rejectionReason": "",
    "createdAt": "2026-10-01T09:30:00",
    "updatedAt": "2026-10-01T09:48:00",
    "items": [
      {
        "id": "seed-23",
        "itemKey": "o_ticket",
        "fields": {
          "date": "2026-09-26",
          "modeOfTravel": "Flight",
          "fromLocation": "Chennai",
          "toLocation": "Hyderabad",
          "fromDate": "2026-09-28",
          "fromTime": "08:00",
          "toDate": "2026-09-30",
          "toTime": "19:30",
          "billerName": "Air India",
          "billNumber": "PNR H8ZK2P",
          "amount": 3200
        },
        "attachments": [
          {
            "name": "airindia-eticket.pdf",
            "size": 136192,
            "type": "application/pdf"
          }
        ],
        "approvedAmount": null,
        "approverRemarks": ""
      },
      {
        "id": "seed-24",
        "itemKey": "o_lodge",
        "fields": {
          "date": "2026-09-30",
          "stayLocation": "Hyderabad",
          "fromDate": "2026-09-28",
          "toDate": "2026-09-30",
          "billerName": "Ibis Hitec City",
          "billNumber": "IB-20991",
          "amount": 2800
        },
        "attachments": [
          {
            "name": "ibis-invoice.pdf",
            "size": 226304,
            "type": "application/pdf"
          }
        ],
        "approvedAmount": null,
        "approverRemarks": ""
      },
      {
        "id": "seed-25",
        "itemKey": "o_food_lunch",
        "fields": {
          "date": "2026-09-29",
          "time": "13:15",
          "stayLocation": "Hyderabad",
          "billerName": "Paradise",
          "billNumber": "PD-1123",
          "amount": 300
        },
        "attachments": [
          {
            "name": "paradise-bill.jpg",
            "size": 397312,
            "type": "image/jpeg"
          }
        ],
        "approvedAmount": null,
        "approverRemarks": ""
      }
    ]
  },
  {
    "id": "seed-26",
    "kind": "claim",
    "requestNumber": "800002/2026/0007",
    "employeeCode": "800002",
    "employeeName": "Mani Bharathi",
    "costCentre": "CC-103 · Operations",
    "expenseType": "local",
    "purpose": "Warehouse inspection",
    "requestDate": "2026-09-18",
    "status": "rejected",
    "submittedOn": "2026-09-18",
    "approvedOn": "2026-09-18",
    "approver": "Priya Natarajan",
    "employeeComments": "",
    "approverComments": "",
    "rejectionReason": "Duplicate of request 800002/2026/0006 (already approved).",
    "createdAt": "2026-09-18T11:11:00",
    "updatedAt": "2026-09-18T15:00:00",
    "items": [
      {
        "id": "seed-27",
        "itemKey": "l_conveyance",
        "fields": {
          "date": "2026-09-17",
          "modeOfTravel": "Cab",
          "fromLocation": "Office",
          "toLocation": "Sriperumbudur warehouse",
          "billNumber": "OLA-55210",
          "amount": 780
        },
        "attachments": [
          {
            "name": "ola-receipt-2.pdf",
            "size": 47104,
            "type": "application/pdf"
          }
        ],
        "approvedAmount": 0,
        "approverRemarks": "Duplicate"
      }
    ]
  },
  {
    "id": "seed-28",
    "kind": "claim",
    "requestNumber": "800002/2026/0008",
    "employeeCode": "800002",
    "employeeName": "Mani Bharathi",
    "costCentre": "CC-103 · Operations",
    "expenseType": "other",
    "purpose": "Vehicle service",
    "requestDate": "2026-10-02",
    "status": "submitted",
    "submittedOn": "2026-10-02",
    "approvedOn": null,
    "approver": null,
    "employeeComments": "",
    "approverComments": "",
    "rejectionReason": "",
    "createdAt": "2026-10-02T08:05:00",
    "updatedAt": "2026-10-02T08:20:00",
    "items": [
      {
        "id": "seed-29",
        "itemKey": "s_vehicle",
        "fields": {
          "date": "2026-09-28",
          "billerName": "Maruti Service Centre",
          "billNumber": "MSC-77810",
          "amount": 4600,
          "remarks": "40,000 km service"
        },
        "attachments": [
          {
            "name": "maruti-service.pdf",
            "size": 271360,
            "type": "application/pdf"
          }
        ],
        "approvedAmount": null,
        "approverRemarks": ""
      }
    ]
  },
  {
    "id": "seed-30",
    "kind": "claim",
    "requestNumber": "800002/2026/0009",
    "employeeCode": "800002",
    "employeeName": "Mani Bharathi",
    "costCentre": "CC-103 · Operations",
    "expenseType": "fuel",
    "purpose": "Fuel for site visits",
    "requestDate": "2026-10-02",
    "status": "submitted",
    "submittedOn": "2026-10-02",
    "approvedOn": null,
    "approver": null,
    "employeeComments": "",
    "approverComments": "",
    "rejectionReason": "",
    "createdAt": "2026-10-02T08:25:00",
    "updatedAt": "2026-10-02T08:30:00",
    "items": [
      {
        "id": "seed-31",
        "itemKey": "s_fuel_litres",
        "fields": {
          "date": "2026-09-30",
          "billerName": "HP Petrol Bunk",
          "billNumber": "HP-21190",
          "qty": 35,
          "amount": 3640
        },
        "attachments": [
          {
            "name": "hp-fuel-bill.jpg",
            "size": 411648,
            "type": "image/jpeg"
          }
        ],
        "approvedAmount": null,
        "approverRemarks": ""
      }
    ]
  },
  {
    "id": "seed-32",
    "kind": "claim",
    "requestNumber": "800003/2026/0003",
    "employeeCode": "800003",
    "employeeName": "Divya Sree",
    "costCentre": "CC-104 · Finance",
    "expenseType": "local",
    "purpose": "Bank visit for statutory filing",
    "requestDate": "2026-09-25",
    "status": "approved",
    "submittedOn": "2026-09-25",
    "approvedOn": "2026-09-25",
    "approver": "Priya Natarajan",
    "employeeComments": "",
    "approverComments": "",
    "rejectionReason": "",
    "createdAt": "2026-09-25T13:20:00",
    "updatedAt": "2026-09-25T17:00:00",
    "items": [
      {
        "id": "seed-33",
        "itemKey": "l_conveyance",
        "fields": {
          "date": "2026-09-25",
          "modeOfTravel": "Cab",
          "fromLocation": "Office",
          "toLocation": "SBI Nungambakkam",
          "billNumber": "UB-9921",
          "amount": 560
        },
        "attachments": [
          {
            "name": "uber-9921.pdf",
            "size": 45056,
            "type": "application/pdf"
          }
        ],
        "approvedAmount": 560,
        "approverRemarks": ""
      },
      {
        "id": "seed-34",
        "itemKey": "l_food_lunch",
        "fields": {
          "date": "2026-09-25",
          "billerName": "Adyar Ananda Bhavan",
          "billNumber": "2215",
          "amount": 190
        },
        "attachments": [
          {
            "name": "a2b-bill.jpg",
            "size": 307200,
            "type": "image/jpeg"
          }
        ],
        "approvedAmount": 190,
        "approverRemarks": ""
      }
    ]
  },
  {
    "id": "seed-35",
    "kind": "claim",
    "requestNumber": "800003/2026/0004",
    "employeeCode": "800003",
    "employeeName": "Divya Sree",
    "costCentre": "CC-104 · Finance",
    "expenseType": "local",
    "purpose": "Auditor meeting",
    "requestDate": "2026-10-04",
    "status": "submitted",
    "submittedOn": "2026-10-04",
    "approvedOn": null,
    "approver": null,
    "employeeComments": "",
    "approverComments": "",
    "rejectionReason": "",
    "createdAt": "2026-10-04T16:00:00",
    "updatedAt": "2026-10-04T16:12:00",
    "items": [
      {
        "id": "seed-36",
        "itemKey": "l_conveyance",
        "fields": {
          "date": "2026-10-04",
          "modeOfTravel": "Metro",
          "fromLocation": "Office",
          "toLocation": "Nandanam",
          "billNumber": "",
          "amount": 240
        },
        "attachments": [],
        "approvedAmount": null,
        "approverRemarks": ""
      },
      {
        "id": "seed-37",
        "itemKey": "l_food_lunch",
        "fields": {
          "date": "2026-10-04",
          "billerName": "Murugan Idli Shop",
          "billNumber": "0912",
          "amount": 190
        },
        "attachments": [
          {
            "name": "murugan-bill.jpg",
            "size": 281600,
            "type": "image/jpeg"
          }
        ],
        "approvedAmount": null,
        "approverRemarks": ""
      }
    ]
  },
  {
    "id": "seed-38",
    "kind": "claim",
    "requestNumber": "800004/2026/0021",
    "employeeCode": "800004",
    "employeeName": "Arun Prasad",
    "costCentre": "CC-101 · Engineering",
    "expenseType": "local",
    "purpose": "Data centre visit",
    "requestDate": "2026-09-05",
    "status": "approved",
    "submittedOn": "2026-09-05",
    "approvedOn": "2026-09-08",
    "approver": "Priya Natarajan",
    "employeeComments": "",
    "approverComments": "",
    "rejectionReason": "",
    "createdAt": "2026-09-05T09:00:00",
    "updatedAt": "2026-09-08T10:30:00",
    "items": [
      {
        "id": "seed-39",
        "itemKey": "l_conveyance",
        "fields": {
          "date": "2026-09-04",
          "modeOfTravel": "Cab",
          "fromLocation": "Office",
          "toLocation": "Siruseri DC",
          "billNumber": "OLA-11002",
          "amount": 940
        },
        "attachments": [
          {
            "name": "ola-11002.pdf",
            "size": 48128,
            "type": "application/pdf"
          }
        ],
        "approvedAmount": 940,
        "approverRemarks": ""
      },
      {
        "id": "seed-40",
        "itemKey": "l_food_dinner",
        "fields": {
          "date": "2026-09-04",
          "billerName": "Hotel Sangeetha",
          "billNumber": "7781",
          "amount": 180
        },
        "attachments": [
          {
            "name": "sangeetha-bill.jpg",
            "size": 296960,
            "type": "image/jpeg"
          }
        ],
        "approvedAmount": 180,
        "approverRemarks": ""
      }
    ]
  },
  {
    "id": "seed-41",
    "kind": "claim",
    "requestNumber": "800004/2026/0022",
    "employeeCode": "800004",
    "employeeName": "Arun Prasad",
    "costCentre": "CC-101 · Engineering",
    "expenseType": "medical",
    "purpose": "Dental procedure",
    "requestDate": "2026-09-30",
    "status": "submitted",
    "submittedOn": "2026-09-30",
    "approvedOn": null,
    "approver": null,
    "employeeComments": "Root canal, two sittings.",
    "approverComments": "",
    "rejectionReason": "",
    "createdAt": "2026-09-30T18:30:00",
    "updatedAt": "2026-09-30T18:41:00",
    "items": [
      {
        "id": "seed-42",
        "itemKey": "s_med_dental",
        "fields": {
          "date": "2026-09-27",
          "billerName": "Smile Dental Care",
          "billNumber": "SDC-3310",
          "amount": 5500
        },
        "attachments": [
          {
            "name": "smile-dental.pdf",
            "size": 120832,
            "type": "application/pdf"
          }
        ],
        "approvedAmount": null,
        "approverRemarks": ""
      }
    ]
  },
  {
    "id": "seed-43",
    "kind": "travel",
    "requestNumber": "TR/2026/0041",
    "employeeCode": "800001",
    "employeeName": "Karthik R",
    "costCentre": "CC-101 · Engineering",
    "requestDate": "2026-09-15",
    "purpose": "Client Visit",
    "remarks": "Bengaluru rollout – on-site support for go-live",
    "fromLocation": "Chennai",
    "toLocation": "Bengaluru",
    "periodFrom": "2026-09-23T06:00",
    "periodTo": "2026-09-25T21:00",
    "items": [
      {
        "id": "seed-44",
        "item": "Ticket Fare",
        "amount": 2500,
        "remarks": "Train, 2A both ways"
      },
      {
        "id": "seed-45",
        "item": "Lodging",
        "amount": 6000,
        "remarks": "2 nights"
      },
      {
        "id": "seed-46",
        "item": "Food",
        "amount": 1200,
        "remarks": ""
      }
    ],
    "advanceRequired": 5000,
    "overallRemarks": "Hotel to be booked via travel desk.",
    "approverRemarks": "Approved. Keep bills for all items.",
    "alongWith": "Selva Kumar",
    "attachments": [
      {
        "name": "client-invite.pdf",
        "size": 90112,
        "type": "application/pdf"
      }
    ],
    "createLeave": false,
    "status": "approved",
    "submittedOn": "2026-09-15",
    "approvedOn": "2026-09-16",
    "approver": "Priya Natarajan",
    "createdAt": "2026-09-15T10:00:00",
    "updatedAt": "2026-09-16T09:00:00"
  },
  {
    "id": "seed-47",
    "kind": "travel",
    "requestNumber": "TR/2026/0048",
    "employeeCode": "800001",
    "employeeName": "Karthik R",
    "costCentre": "CC-101 · Engineering",
    "requestDate": "2026-10-04",
    "purpose": "Training",
    "remarks": "Cloud architecture workshop, Pune",
    "fromLocation": "Chennai",
    "toLocation": "Pune",
    "periodFrom": "2026-10-20T07:30",
    "periodTo": "2026-10-22T22:00",
    "items": [
      {
        "id": "seed-48",
        "item": "Ticket Fare",
        "amount": 7000,
        "remarks": "Flight"
      },
      {
        "id": "seed-49",
        "item": "Lodging",
        "amount": 4000,
        "remarks": "2 nights"
      },
      {
        "id": "seed-50",
        "item": "Food",
        "amount": 1000,
        "remarks": ""
      }
    ],
    "advanceRequired": 6000,
    "overallRemarks": "",
    "approverRemarks": "",
    "alongWith": "",
    "attachments": [
      {
        "name": "workshop-nomination.pdf",
        "size": 65536,
        "type": "application/pdf"
      }
    ],
    "createLeave": false,
    "status": "submitted",
    "submittedOn": "2026-10-04",
    "approvedOn": null,
    "approver": null,
    "createdAt": "2026-10-04T11:20:00",
    "updatedAt": "2026-10-04T11:35:00"
  },
  {
    "id": "seed-51",
    "kind": "travel",
    "requestNumber": "TR/2026/0045",
    "employeeCode": "800003",
    "employeeName": "Divya Sree",
    "costCentre": "CC-104 · Finance",
    "requestDate": "2026-10-02",
    "purpose": "Audit",
    "remarks": "Statutory audit at the Delhi branch",
    "fromLocation": "Chennai",
    "toLocation": "New Delhi",
    "periodFrom": "2026-11-03T05:30",
    "periodTo": "2026-11-06T23:00",
    "items": [
      {
        "id": "seed-52",
        "item": "Ticket Fare",
        "amount": 11000,
        "remarks": "Flight"
      },
      {
        "id": "seed-53",
        "item": "Lodging",
        "amount": 9000,
        "remarks": "3 nights"
      },
      {
        "id": "seed-54",
        "item": "Local Conveyance",
        "amount": 1500,
        "remarks": ""
      }
    ],
    "advanceRequired": 8000,
    "overallRemarks": "",
    "approverRemarks": "",
    "alongWith": "",
    "attachments": [],
    "createLeave": true,
    "status": "submitted",
    "submittedOn": "2026-10-02",
    "approvedOn": null,
    "approver": null,
    "createdAt": "2026-10-02T14:00:00",
    "updatedAt": "2026-10-02T14:10:00"
  },
  {
    "id": "seed-55",
    "kind": "advance",
    "requestNumber": "AR/2026/0017",
    "employeeCode": "800001",
    "employeeName": "Karthik R",
    "costCentre": "CC-101 · Engineering",
    "requestDate": "2026-09-16",
    "periodFrom": "2026-09-23",
    "periodTo": "2026-09-25",
    "amount": 5000,
    "purpose": "Client Visit",
    "remarks": "Advance for the Bengaluru rollout",
    "alongWith": "Selva Kumar",
    "attachments": [],
    "createLeave": false,
    "travelRequest": "TR/2026/0041",
    "settled": false,
    "approverRemarks": "Released to salary account.",
    "status": "approved",
    "submittedOn": "2026-09-16",
    "approvedOn": "2026-09-17",
    "approver": "Priya Natarajan",
    "createdAt": "2026-09-16T09:00:00",
    "updatedAt": "2026-09-17T12:00:00"
  },
  {
    "id": "seed-56",
    "kind": "advance",
    "requestNumber": "AR/2026/0023",
    "employeeCode": "800001",
    "employeeName": "Karthik R",
    "costCentre": "CC-101 · Engineering",
    "requestDate": "2026-10-04",
    "periodFrom": "2026-10-20",
    "periodTo": "2026-10-22",
    "amount": 6000,
    "purpose": "Training",
    "remarks": "Advance for the Pune workshop",
    "alongWith": "",
    "attachments": [],
    "createLeave": false,
    "travelRequest": "TR/2026/0048",
    "settled": false,
    "approverRemarks": "",
    "status": "submitted",
    "submittedOn": "2026-10-04",
    "approvedOn": null,
    "approver": null,
    "createdAt": "2026-10-04T11:40:00",
    "updatedAt": "2026-10-04T11:40:00"
  },
  {
    "id": "seed-57",
    "kind": "advance",
    "requestNumber": "AR/2026/0019",
    "employeeCode": "800000",
    "employeeName": "Selva Kumar",
    "costCentre": "CC-102 · Sales",
    "requestDate": "2026-09-25",
    "periodFrom": "2026-09-28",
    "periodTo": "2026-09-30",
    "amount": 3000,
    "purpose": "Internal Meeting",
    "remarks": "QBR – Hyderabad",
    "alongWith": "",
    "attachments": [],
    "createLeave": false,
    "travelRequest": "",
    "settled": false,
    "approverRemarks": "",
    "status": "approved",
    "submittedOn": "2026-09-25",
    "approvedOn": "2026-09-26",
    "approver": "Priya Natarajan",
    "createdAt": "2026-09-25T10:00:00",
    "updatedAt": "2026-09-26T10:00:00"
  },
  {
    "id": "seed-58",
    "kind": "advance",
    "requestNumber": "AR/2026/0022",
    "employeeCode": "800003",
    "employeeName": "Divya Sree",
    "costCentre": "CC-104 · Finance",
    "requestDate": "2026-10-02",
    "periodFrom": "2026-11-03",
    "periodTo": "2026-11-06",
    "amount": 8000,
    "purpose": "Audit",
    "remarks": "Advance for the Delhi audit",
    "alongWith": "",
    "attachments": [],
    "createLeave": true,
    "travelRequest": "TR/2026/0045",
    "settled": false,
    "approverRemarks": "",
    "status": "submitted",
    "submittedOn": "2026-10-02",
    "approvedOn": null,
    "approver": null,
    "createdAt": "2026-10-02T14:20:00",
    "updatedAt": "2026-10-02T14:20:00"
  }
] as unknown as TravelClaimRecord[];

export const SEED_RECEIPTS = [
  {
    "id": "rcpt-1",
    "employeeCode": "800001",
    "file": {
      "name": "uber-trip-oct05.jpg",
      "size": 219136,
      "type": "image/jpeg"
    },
    "uploadedAt": "2026-10-05T19:40:00",
    "date": "2026-10-05",
    "billerName": "Uber",
    "billNumber": "UB-88124",
    "amount": 410,
    "notes": "Office to client site, Guindy",
    "usedIn": null
  },
  {
    "id": "rcpt-2",
    "employeeCode": "800001",
    "file": {
      "name": "apollo-pharmacy-1009.pdf",
      "size": 98304,
      "type": "application/pdf"
    },
    "uploadedAt": "2026-10-09T21:05:00",
    "date": "2026-10-09",
    "billerName": "Apollo Pharmacy",
    "billNumber": "AP-77310",
    "amount": 640,
    "notes": "Prescribed medicines",
    "usedIn": null
  },
  {
    "id": "rcpt-3",
    "employeeCode": "800001",
    "file": {
      "name": "hp-fuel-1010.jpg",
      "size": 397312,
      "type": "image/jpeg"
    },
    "uploadedAt": "2026-10-10T08:15:00",
    "date": "2026-10-10",
    "billerName": "HP Petrol Bunk",
    "billNumber": "HP-30981",
    "amount": 2100,
    "notes": "",
    "usedIn": null
  },
  {
    "id": "rcpt-4",
    "employeeCode": "800001",
    "file": {
      "name": "saravana-lunch-1010.jpg",
      "size": 309248,
      "type": "image/jpeg"
    },
    "uploadedAt": "2026-10-10T14:02:00",
    "date": "2026-10-10",
    "billerName": "Saravana Bhavan",
    "billNumber": "5582",
    "amount": 260,
    "notes": "Lunch with vendor team",
    "usedIn": null
  },
  {
    "id": "rcpt-5",
    "employeeCode": "800001",
    "file": {
      "name": "meenakshi-clinic-1011.pdf",
      "size": 59392,
      "type": "application/pdf"
    },
    "uploadedAt": "2026-10-11T18:30:00",
    "date": "2026-10-11",
    "billerName": "Dr. Meenakshi Clinic",
    "billNumber": "MC-1219",
    "amount": 700,
    "notes": "Follow-up consultation",
    "usedIn": null
  }
] as unknown as Receipt[];
