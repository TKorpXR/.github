---
name: Task
description: Prévoir une tâche hors bug ou nouvelle fonctionnalité (tests, configuration, traduction, etc)
projects: ["pulse-web-interface"]
type: Task
body:
  - type: checkboxes
    id: type-feature
    attributes:
      label: "Préciser le type de la tâche. (Si aucune option ne correspond, choisir 'Autre' et indiquer le type dans le champ de description)"
      options:
        - label: Tests
        - label: Traduction
        - label: Sécurité
        - label: Configuration
        - label: Autre
  - type: input
    id: url
    attributes:
      label: "Cible"
      description: "Aides-nous à localiser le problème. Pour les devs : il est possible d'indiquer le chemin relatif vers le composant"
      placeholder: "https://pulse-xr.com/page-avec-bug"
    validations:
      required: false
  - type: input
    id: feature
    attributes:
      label: "Description courte de la tâche"
      description: "Un résumé de la tâche demandée"
    validations:
      required: true
  - type: textarea
    id: feature-detailed
    attributes:
      label: "Description complète de la tâche"
      description: "Un résumé de la tâche demandée. N'hésite pas à ajouter une ou plusieurs captures d'écran"
    validations:
      required: true
